// Upload state machine and error mapping for case photos. Pure so it can be tested without a DOM.
import { MAX_IMAGES } from './images';

export type UploadErrorKind = 'full' | 'too_large' | 'bad_type' | 'invalid' | 'forbidden' | 'rate_limited' | 'not_found' | 'network' | 'server' | 'other';
export interface UploadError {
  kind: UploadErrorKind;
  message: string;
  /** Worth pressing "Retry" with the same id? */
  retryable: boolean;
}

/** Maps the contract's status codes (409 full, 413 too big, 415 wrong type, 422 invalid, ...) to words a dispatcher can act on. */
export function mapUploadError(status: number, serverMessage?: string): UploadError {
  switch (status) {
    case 409:
      return { kind: 'full', message: `This case already has ${MAX_IMAGES} photos. Delete one to add another.`, retryable: false };
    case 413:
      return { kind: 'too_large', message: 'The photo is larger than 3 MB. Pick a smaller one.', retryable: false };
    case 415:
      return { kind: 'bad_type', message: 'Only JPEG and PNG photos are accepted.', retryable: false };
    case 422:
      return { kind: 'invalid', message: 'The server could not read this image (damaged or incomplete file). Pick another photo.', retryable: false };
    case 403:
      return { kind: 'forbidden', message: 'Only an admin or the assigned responder can add photos.', retryable: false };
    case 404:
      return { kind: 'not_found', message: 'This case no longer exists.', retryable: false };
    case 429:
      return { kind: 'rate_limited', message: 'Too many uploads at once. Wait a moment, then retry.', retryable: true };
    case 0:
      return { kind: 'network', message: 'Cannot reach the server. Check the connection and retry; nothing is duplicated.', retryable: true };
    default:
      return status >= 500
        ? { kind: 'server', message: 'The server had a problem saving the photo. Retry in a moment.', retryable: true }
        : { kind: 'other', message: serverMessage || 'The photo could not be uploaded.', retryable: false };
  }
}

export type UploadStatus = 'processing' | 'ready' | 'uploading' | 'failed';
export interface UploadItem {
  /** Client-generated UUID, reused by every retry so the server never stores a photo twice */
  id: string;
  name: string;
  caption: string;
  status: UploadStatus;
  error?: UploadError;
  contentType?: string;
  bytes?: number;
  width?: number;
  height?: number;
  attempts: number;
}

export type UploadAction =
  | { type: 'add'; id: string; name: string }
  | { type: 'processed'; id: string; contentType: string; bytes: number; width: number; height: number }
  | { type: 'process_failed'; id: string; error: UploadError }
  | { type: 'caption'; id: string; text: string }
  | { type: 'start'; id: string }
  | { type: 'failed'; id: string; error: UploadError }
  | { type: 'retry'; id: string }
  | { type: 'done'; id: string }
  | { type: 'remove'; id: string };

export function uploadReducer(state: UploadItem[], a: UploadAction): UploadItem[] {
  const patch = (id: string, f: (i: UploadItem) => UploadItem) => state.map((i) => (i.id === id ? f(i) : i));
  switch (a.type) {
    case 'add':
      return state.some((i) => i.id === a.id) ? state : [...state, { id: a.id, name: a.name, caption: '', status: 'processing', attempts: 0 }];
    case 'processed':
      return patch(a.id, (i) => ({ ...i, status: 'ready', error: undefined, contentType: a.contentType, bytes: a.bytes, width: a.width, height: a.height }));
    case 'process_failed':
      return patch(a.id, (i) => ({ ...i, status: 'failed', error: a.error }));
    case 'caption':
      return patch(a.id, (i) => ({ ...i, caption: a.text.slice(0, 200) }));
    case 'start':
      return patch(a.id, (i) => ({ ...i, status: 'uploading', error: undefined, attempts: i.attempts + 1 }));
    case 'failed':
      return patch(a.id, (i) => ({ ...i, status: 'failed', error: a.error }));
    case 'retry':
      // same id on purpose: a replay answers 200 instead of creating a duplicate
      return patch(a.id, (i) => (i.status === 'failed' && i.error?.retryable !== false && i.contentType ? { ...i, status: 'ready', error: undefined } : i));
    case 'done':
    case 'remove':
      return state.filter((i) => i.id !== a.id);
  }
}

/** How many more photos may still be added, counting stored photos and the ones staged or in flight. */
export const slotsLeft = (stored: number, staged: number): number => Math.max(0, MAX_IMAGES - stored - staged);

export interface PutResult {
  created: boolean;
}

/** Runs one upload attempt with the item's own id. Never throws: errors come back mapped. */
export async function performUpload(
  item: Pick<UploadItem, 'id' | 'caption'>,
  put: (id: string, caption: string) => Promise<PutResult>,
  statusOf: (e: unknown) => { status: number; message?: string },
): Promise<{ ok: true; created: boolean } | { ok: false; error: UploadError }> {
  try {
    const r = await put(item.id, item.caption.trim());
    return { ok: true, created: r.created };
  } catch (e) {
    const s = statusOf(e);
    return { ok: false, error: mapUploadError(s.status, s.message) };
  }
}
