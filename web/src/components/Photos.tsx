import { useCallback, useEffect, useId, useReducer, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import * as api from '../api/endpoints';
import type { CaseImage } from '../api/models';
import { invalidateCase, qk, useAction } from '../hooks/data';
import { MAX_CAPTION, MAX_IMAGES, ImageError, ObjectUrlRegistry, PhotoStore, formatBytes, pickImageFiles, processImage } from '../lib/images';
import { mapUploadError, performUpload, slotsLeft, uploadReducer, type UploadItem } from '../lib/photoUpload';
import { formatDateTime } from '../lib/time';
import { useUi } from '../state/ui';
import { IcCamera } from './icons';
import { ConfirmDialog } from './ui';

const statusOf = (e: unknown) => (e instanceof ApiError ? { status: e.status, message: e.message } : { status: 0 });

/** True once the element is (about to be) on screen; without IntersectionObserver everything counts as visible. */
function useVisible<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: '120px' });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

type PhotoState = { s: 'loading' } | { s: 'ready'; url: string } | { s: 'error'; message: string };

/** Loads one photo through the store (authenticated fetch -> object URL). `enabled` makes it lazy. */
function usePhoto(store: PhotoStore, id: string, enabled: boolean): [PhotoState, () => void] {
  const [state, setState] = useState<PhotoState>(() => {
    const p = store.peek(id);
    return p ? { s: 'ready', url: p.url } : { s: 'loading' };
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const p = store.peek(id);
    if (p) {
      setState({ s: 'ready', url: p.url });
      return;
    }
    let live = true;
    setState({ s: 'loading' });
    store
      .get(id)
      .then((r) => live && setState({ s: 'ready', url: r.url }))
      .catch((e: unknown) => live && setState({ s: 'error', message: e instanceof ApiError && e.status === 403 ? 'Not allowed to view this photo' : 'Could not load this photo' }));
    return () => {
      live = false;
    };
  }, [store, id, enabled, attempt]);
  return [state, () => setAttempt((n) => n + 1)];
}

function Thumb({ store, image, index, onOpen }: { store: PhotoStore; image: CaseImage; index: number; onOpen: () => void }) {
  const [ref, visible] = useVisible<HTMLDivElement>();
  const [st, retry] = usePhoto(store, image.id, visible);
  const label = image.caption ? `Photo ${index + 1}: ${image.caption}` : `Photo ${index + 1}`;
  return (
    <div className="photo-cell" ref={ref} role="listitem">
      {st.s === 'ready' ? (
        <button type="button" className="photo-btn" onClick={onOpen} aria-label={`Open ${label}`}>
          <img src={st.url} alt={label} loading="lazy" decoding="async" />
        </button>
      ) : st.s === 'error' ? (
        <div className="photo-err" role="group" aria-label={label}>
          <span>{st.message}</span>
          <button type="button" className="btn sm" onClick={() => { store.drop(image.id); retry(); }}>Retry</button>
        </div>
      ) : (
        <div className="skel photo-skel" aria-busy="true" aria-label={`Loading ${label}`} />
      )}
    </div>
  );
}

function Lightbox({ store, images, start, canDelete, onDelete, deleting, onClose }: {
  store: PhotoStore;
  images: CaseImage[];
  start: number;
  canDelete: (i: CaseImage) => boolean;
  onDelete: (i: CaseImage) => void;
  deleting: boolean;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(Math.min(start, images.length - 1));
  const [confirm, setConfirm] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const confirming = useRef(false);
  confirming.current = confirm;
  const image = images[Math.min(idx, images.length - 1)];
  const [st, retry] = usePhoto(store, image?.id ?? '', !!image);
  const n = images.length;

  // an image deleted from under us (or by a live update) leaves fewer photos: keep the index valid, close when none are left
  useEffect(() => {
    if (n === 0) onClose();
    else if (idx > n - 1) setIdx(n - 1);
  }, [n, idx, onClose]);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const focusables = () => Array.from(el?.querySelectorAll<HTMLElement>('button,a[href],[tabindex]:not([tabindex="-1"])') ?? []).filter((x) => !x.hasAttribute('disabled'));
    const onKey = (e: KeyboardEvent) => {
      if (confirming.current) return; // the confirm dialog owns the keyboard
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setIdx((i) => Math.min(i + 1, n - 1));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setIdx(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setIdx(n - 1);
      } else if (e.key === 'Tab') {
        const f = focusables();
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [n, onClose]);

  if (!image) return null;
  const by = image.uploaded_by.kind === 'responder' ? (image.uploaded_by.responder_name ?? 'a responder') : 'the person who asked for help';
  const ext = image.content_type === 'image/png' ? 'png' : 'jpg';
  return (
    <div className="lb-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="lb" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="lb-top">
          <h3 id={titleId}>Photo {idx + 1} of {n}</h3>
          <button type="button" className="btn sm" onClick={onClose} data-autofocus>Close <span className="esc-hint" aria-hidden="true">Esc</span></button>
        </div>
        <div className="lb-stage">
          <button type="button" className="lb-nav prev" onClick={() => setIdx((i) => Math.max(i - 1, 0))} disabled={idx === 0} aria-label="Previous photo">‹</button>
          <div className="lb-img" aria-live="polite">
            {st.s === 'ready' && <img src={st.url} alt={image.caption || `Photo ${idx + 1} of ${n}`} />}
            {st.s === 'loading' && <div className="skel lb-skel" aria-busy="true" aria-label="Loading photo" />}
            {st.s === 'error' && (
              <div className="photo-err" role="alert">
                <span>{st.message}</span>
                <button type="button" className="btn sm" onClick={() => { store.drop(image.id); retry(); }}>Retry</button>
              </div>
            )}
          </div>
          <button type="button" className="lb-nav next" onClick={() => setIdx((i) => Math.min(i + 1, n - 1))} disabled={idx === n - 1} aria-label="Next photo">›</button>
        </div>
        <div className="lb-info">
          <p className="lb-cap">{image.caption || <span className="muted">No caption</span>}</p>
          <p className="note">
            Uploaded by {by} · {formatDateTime(image.created_at)} · {formatBytes(image.bytes)} · {image.width} × {image.height}
          </p>
          <div className="lb-acts">
            {st.s === 'ready' ? (
              <a className="btn sm" href={st.url} download={`beacon-photo-${image.id.slice(0, 8)}.${ext}`}>Download</a>
            ) : (
              <button type="button" className="btn sm" disabled>Download</button>
            )}
            {canDelete(image) && <button type="button" className="btn sm danger" onClick={() => setConfirm(true)}>Delete…</button>}
          </div>
        </div>
        {confirm && (
          <ConfirmDialog
            title="Delete this photo?"
            danger
            confirmLabel="Delete photo"
            busy={deleting}
            body="The photo is removed from the case for everyone. This cannot be undone."
            onClose={() => setConfirm(false)}
            onConfirm={() => { onDelete(image); setConfirm(false); }}
          />
        )}
      </div>
    </div>
  );
}

function Staged({ item, preview, onCaption, onUpload, onRetry, onRemove }: {
  item: UploadItem;
  preview?: string;
  onCaption: (t: string) => void;
  onUpload: () => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const capId = useId();
  const busy = item.status === 'processing' || item.status === 'uploading';
  return (
    <div className={`staged ${item.status}`} role="group" aria-label={`Photo to upload: ${item.name}`}>
      <div className="staged-prev">{preview ? <img src={preview} alt="" /> : <div className="skel photo-skel" aria-hidden="true" />}</div>
      <div className="staged-body">
        <b className="staged-name">{item.name}</b>
        <span className="note">
          {item.status === 'processing' ? 'Preparing: fixing rotation, shrinking and removing location data…' : `${item.width} × ${item.height} · ${formatBytes(item.bytes ?? 0)} · ${item.contentType === 'image/png' ? 'PNG' : 'JPEG'}, metadata removed`}
        </span>
        {item.status !== 'processing' && !(item.status === 'failed' && !item.contentType) && (
          <>
            <label className="sr-only" htmlFor={capId}>Caption (optional)</label>
            <input id={capId} className="input" placeholder="Caption (optional, up to 200 characters)" maxLength={MAX_CAPTION} value={item.caption} disabled={item.status === 'uploading'} onChange={(e) => onCaption(e.target.value)} />
          </>
        )}
        {item.status === 'uploading' && (
          <div className="indet" role="progressbar" aria-label="Uploading photo" aria-busy="true"><i /></div>
        )}
        {item.status === 'failed' && item.error && <p className="form-err" role="alert" style={{ padding: 0 }}>{item.error.message}</p>}
        <div className="staged-acts">
          {item.status === 'ready' && <button type="button" className="btn sm primary" onClick={onUpload}>Upload photo</button>}
          {item.status === 'uploading' && <button type="button" className="btn sm primary" disabled>Uploading…</button>}
          {item.status === 'failed' && item.error?.retryable && item.contentType && <button type="button" className="btn sm primary" onClick={onRetry}>Retry upload</button>}
          <button type="button" className="btn sm" onClick={onRemove} disabled={busy && item.status === 'uploading'}>{item.status === 'failed' ? 'Discard' : 'Cancel'}</button>
        </div>
      </div>
    </div>
  );
}

export interface PhotosProps {
  sosId: string;
  /** Server count (everyone gets it) */
  count: number;
  /** Photo metadata; undefined = the viewer is not entitled (not an admin or the active assignee) */
  images?: CaseImage[];
  /** Detail not loaded yet */
  loading?: boolean;
  canUpload: boolean;
  isAdmin: boolean;
  /** Responder name of the viewer, to allow deleting their own uploads */
  myName?: string;
  /** Can this viewer claim the case to unlock photos? */
  canClaim: boolean;
}

/** Locked placeholder, or the thumbnail grid + lightbox + add control. */
export function PhotosSection(p: PhotosProps) {
  if (p.loading) return <div className="skel" style={{ height: 96 }} aria-busy="true" aria-label="Loading photos" />;
  if (p.images === undefined) {
    return (
      <div className="photo-locked" data-testid="photos-locked">
        <IcCamera width={22} height={22} />
        <div>
          <b>{p.count} {p.count === 1 ? 'photo' : 'photos'}</b>
          <p>{p.canClaim ? 'Claim this case to see photos' : 'Only admins and the assigned responder can see photos'}</p>
        </div>
      </div>
    );
  }
  return <PhotosUnlocked {...p} images={p.images} />;
}

function PhotosUnlocked({ sosId, images, canUpload, isAdmin, myName }: PhotosProps & { images: CaseImage[] }) {
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  const [store, setStore] = useState<PhotoStore | null>(null);
  useEffect(() => {
    const s = new PhotoStore((id) => api.fetchImageBlob(sosId, id));
    setStore(s);
    return () => s.dispose(); // revoke every object URL when the panel goes away
  }, [sosId]);

  const [open, setOpen] = useState<number | null>(null);
  const closeLb = useCallback(() => setOpen(null), []);
  const del = useAction((imageId: string) => api.deleteImage(sosId, imageId), {
    success: 'Photo deleted',
    invalidate: (qc2, _r, id) => { if (id) store?.drop(id); invalidateCase(qc2, sosId); void qc2.invalidateQueries({ queryKey: qk.open }); },
  });

  const [items, dispatch] = useReducer(uploadReducer, []);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const blobs = useRef(new Map<string, Blob>());
  const previews = useRef(new ObjectUrlRegistry());
  const [previewUrl, setPreviewUrl] = useState<Record<string, string>>({});
  useEffect(() => {
    const reg = previews.current;
    return () => reg.revokeAll();
  }, []);

  const left = slotsLeft(images.length, items.length);
  const refresh = () => { invalidateCase(qc, sosId); void qc.invalidateQueries({ queryKey: qk.open }); };

  const addFiles = (files: File[]) => {
    const picked = pickImageFiles(files);
    if (!picked.length) {
      if (files.length) toast('error', 'That file is not an image. Pick a JPEG or PNG photo.');
      return;
    }
    if (left <= 0) {
      toast('error', mapUploadError(409).message);
      return;
    }
    if (picked.length > left) toast('info', `Only ${left} more ${left === 1 ? 'photo fits' : 'photos fit'} (${MAX_IMAGES} per case). The rest were skipped.`);
    for (const file of picked.slice(0, left)) {
      const id = crypto.randomUUID();
      dispatch({ type: 'add', id, name: file.name || 'Pasted image' });
      processImage(file)
        .then((r) => {
          blobs.current.set(id, r.blob);
          const url = previews.current.create(r.blob);
          setPreviewUrl((m) => ({ ...m, [id]: url }));
          dispatch({ type: 'processed', id, contentType: r.contentType, bytes: r.blob.size, width: r.width, height: r.height });
        })
        .catch((e: unknown) =>
          dispatch({ type: 'process_failed', id, error: { kind: 'invalid', message: e instanceof ImageError ? e.message : 'This image could not be prepared.', retryable: false } }),
        );
    }
  };

  const upload = async (id: string) => {
    const item = itemsRef.current.find((i) => i.id === id);
    const blob = blobs.current.get(id);
    if (!item || !blob) return;
    dispatch({ type: 'start', id });
    const r = await performUpload(item, (imageId, caption) => api.uploadImage(sosId, imageId, blob, caption), statusOf);
    if (r.ok) {
      dispatch({ type: 'done', id });
      previews.current.revoke(previewUrl[id]);
      blobs.current.delete(id);
      toast('success', r.created ? 'Photo added' : 'Photo was already uploaded');
      refresh();
    } else {
      dispatch({ type: 'failed', id, error: r.error });
      if (r.error.kind === 'full') refresh();
    }
  };
  const remove = (id: string) => {
    previews.current.revoke(previewUrl[id]);
    blobs.current.delete(id);
    dispatch({ type: 'remove', id });
  };

  // paste an image from the clipboard anywhere in the panel (not while typing in a field)
  const addRef = useRef(addFiles);
  addRef.current = addFiles;
  useEffect(() => {
    if (!canUpload) return;
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const files = pickImageFiles(e.clipboardData?.files);
      if (files.length) {
        e.preventDefault();
        addRef.current(files);
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [canUpload]);

  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const canDelete = (i: CaseImage) => isAdmin || (i.uploaded_by.kind === 'responder' && !!myName && i.uploaded_by.responder_name === myName);
  const ready = items.filter((i) => i.status === 'ready');

  return (
    <div
      className={`photos${drag ? ' drag' : ''}`}
      onDragOver={(e) => { if (canUpload) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false); }}
      onDrop={(e) => { if (!canUpload) return; e.preventDefault(); setDrag(false); addFiles(Array.from(e.dataTransfer.files)); }}
    >
      <div className="photos-head">
        <span className="photos-count" aria-live="polite">{images.length} of {MAX_IMAGES} photos</span>
        {canUpload && (
          <>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} data-testid="photo-input" />
            <button type="button" className="btn sm" onClick={() => fileRef.current?.click()} disabled={left <= 0}>Add photo</button>
          </>
        )}
      </div>
      {store && images.length > 0 && (
        <div className="photo-grid" role="list" aria-label="Case photos">
          {images.map((img, i) => <Thumb key={img.id} store={store} image={img} index={i} onOpen={() => setOpen(i)} />)}
        </div>
      )}
      {images.length === 0 && items.length === 0 && <p className="note">No photos yet.{canUpload ? '' : ' Photos added to this case appear here.'}</p>}
      {canUpload && items.length === 0 && (
        <p className="note photo-drop">{left <= 0 ? `This case has the maximum of ${MAX_IMAGES} photos. Delete one to add another.` : 'Drag photos here, paste an image (Ctrl+V), or use Add photo. Photos are shrunk to 1600 px and stripped of location data before upload.'}</p>
      )}
      {items.length > 0 && (
        <div className="staged-list">
          {items.map((it) => (
            <Staged key={it.id} item={it} preview={previewUrl[it.id]} onCaption={(t) => dispatch({ type: 'caption', id: it.id, text: t })} onUpload={() => void upload(it.id)} onRetry={() => { dispatch({ type: 'retry', id: it.id }); void upload(it.id); }} onRemove={() => remove(it.id)} />
          ))}
          {ready.length > 1 && <button type="button" className="btn sm primary" onClick={() => ready.forEach((i) => void upload(i.id))}>Upload all {ready.length}</button>}
        </div>
      )}
      {open !== null && store && (
        <Lightbox store={store} images={images} start={open} canDelete={canDelete} onDelete={(i) => del.mutate(i.id)} deleting={del.isPending} onClose={closeLb} />
      )}
    </div>
  );
}
