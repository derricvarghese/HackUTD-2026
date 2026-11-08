import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { Confidence, HopInfo, Sos, SosStatus } from '../api/models';
import { hopChips } from '../lib/hops';
import { CONFIDENCE_CLASS, STATUS_LABEL, caseKind, TIER_TEXT, TIER_VAR } from '../lib/tier';
import { triageInfo } from '../lib/triage';
import { useUi } from '../state/ui';

export function Pill({ bg, color, children, style }: { bg: string; color: string; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <span className="pill" style={{ background: bg, color, ...style }}>
      {children}
    </span>
  );
}

export function StatCard({ icon, iconBg, value, label, delta, deltaBg, deltaColor, tone, valueColor, onClick, loading }: {
  icon?: ReactNode;
  iconBg?: string;
  value: ReactNode;
  label: string;
  delta?: string;
  deltaBg?: string;
  deltaColor?: string;
  tone?: 'red' | 'amber';
  valueColor?: string;
  onClick?: () => void;
  loading?: boolean;
}) {
  const inner = (
    <>
      {icon && (
        <div className="ic" style={{ background: iconBg }}>
          {icon}
        </div>
      )}
      <div>
        <div className="v" style={valueColor ? { color: valueColor } : undefined}>
          {loading ? <span className="skel" style={{ display: 'inline-block', width: 56, height: 28 }} /> : value}
        </div>
        <div className="l">{label}</div>
      </div>
      {delta && (
        <span className="d" style={{ background: deltaBg, color: deltaColor }}>
          {delta}
        </span>
      )}
    </>
  );
  const cls = `stat ${tone ?? ''}${onClick ? ' click' : ''}`;
  return onClick ? (
    <button type="button" className={cls} onClick={onClick}>
      {inner}
    </button>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

/** Class and tooltip for the AI marker on a score badge (hatched ring + pulsing dot while pending, dotted grey ring when AI failed, a flash right after the AI changed the score). */
export function useScoreMarker(c: { id?: string; triage_status?: Sos['triage_status'] }) {
  const info = triageInfo(c.triage_status);
  const changed = useUi((s) => (c.id ? s.triageChanges[c.id] : undefined));
  const cls = `${info.state === 'pending' ? ' ai-pending' : info.state === 'failed' ? ' ai-failed' : ''}${changed ? ' ai-flash' : ''}`;
  return { cls, info, note: info.state === 'pending' || info.state === 'failed' ? info.tooltip : '' };
}

export function ScoreSq({ c, big, label }: { c: Pick<Sos, 'score' | 'silent'> & { id?: string; triage_status?: Sos['triage_status'] }; big?: boolean; label?: string }) {
  const m = useScoreMarker(c);
  const base = label ?? `Priority score ${c.score}`;
  return (
    <span className={`sq${big ? ' big' : ''}${m.cls}`} style={{ background: TIER_VAR[caseKind(c)], color: TIER_TEXT[caseKind(c)] }} title={m.note ? `${base}. ${m.note}` : base} data-ai={m.info.state}>
      {c.score}
      {m.note && <span className="sr-only">{`, ${m.info.label}`}</span>}
    </span>
  );
}

export function Confidence_({ value }: { value?: Confidence | null }) {
  if (!value) return <span className="muted">-</span>;
  return <span className={`cf ${CONFIDENCE_CLASS[value]}`}>{value[0].toUpperCase() + value.slice(1)}</span>;
}

export function StatusChip({ status, silent }: { status: SosStatus; silent?: boolean }) {
  if (silent && (status === 'reported' || status === 'assigned')) return <span className="st sil">Silent</span>;
  const cls: Record<SosStatus, string> = { reported: 'new', assigned: 'asg', en_route: 'enr', on_scene: 'os', resolved: 'res', merged: 'new', closed: 'new' };
  return <span className={`st ${cls[status]}`}>{STATUS_LABEL[status]}</span>;
}

export function HopChips({ hop }: { hop?: HopInfo | null }) {
  const chips = hopChips(hop);
  if (!chips.length) return null;
  return (
    <div className="hops" aria-label="Relay path">
      {chips.map((c, i) => (
        <span key={i} style={{ display: 'contents' }}>
          {i > 0 && <span className="arr">→</span>}
          <span className={`hop${c.gateway ? ' gw' : ''}`}>{c.label}</span>
        </span>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div className="errbox" role="alert">
      Could not load this: {msg}
      {onRetry && (
        <button className="btn sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Skeletons({ n = 3, className = 'case-sk' }: { n?: number; className?: string }) {
  return (
    <div className="q tall" aria-busy="true" aria-label="Loading">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className={`skel ${className}`} />
      ))}
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.v} type="button" className={o.v === value ? 'on' : ''} aria-pressed={o.v === value} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Modal with focus trap, Escape to close and focus restore. */
export function Modal({ title, onClose, children, actions, wide, escapeGuard }: { title: string; onClose: () => void; children: ReactNode; actions?: ReactNode; wide?: boolean; escapeGuard?: () => boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const guard = useRef(escapeGuard);
  guard.current = escapeGuard;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () => Array.from(el?.querySelectorAll<HTMLElement>('button,input,select,textarea,[href],[tabindex]:not([tabindex="-1"])') ?? []).filter((x) => !x.hasAttribute('disabled'));
    (el?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0] ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (guard.current?.()) return; // e.g. the geofence editor cancels an unfinished drawing first
        onClose();
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
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref} tabIndex={-1}>
        <h3 id={id}>{title}</h3>
        <div className="body">{children}</div>
        {actions && <div className="acts">{actions}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, body, confirmLabel, danger, busy, onConfirm, onClose }: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose} data-autofocus>
            Cancel
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy} onClick={onConfirm}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      {body}
    </Modal>
  );
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} role={t.tone === 'error' ? 'alert' : 'status'}>
          <span>{t.text}</span>
          <button aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** Status trail on queue cards: Reported -> Assigned -> En route -> On scene -> Resolved. */
export function StatusTrail({ status, eta }: { status: SosStatus; eta?: number | null }) {
  const steps: { k: SosStatus; label: string }[] = [
    { k: 'reported', label: 'Reported' },
    { k: 'assigned', label: 'Assigned' },
    { k: 'en_route', label: 'En route' },
    { k: 'on_scene', label: 'On scene' },
    { k: 'resolved', label: 'Resolved' },
  ];
  const idx = steps.findIndex((s) => s.k === status);
  return (
    <div className="trail" aria-label={`Status: ${STATUS_LABEL[status]}`}>
      {steps.map((s, i) => (
        <span key={s.k} style={{ display: 'contents' }}>
          {i > 0 && <i />}
          <span className={i < idx || status === 'resolved' ? 'ok' : i === idx ? 'now' : ''}>
            {i < idx || status === 'resolved' ? '● ' : i === idx ? '● ' : '○ '}
            {s.label}
            {i === idx && s.k === 'en_route' && eta ? ` · ETA ${eta} min` : ''}
          </span>
        </span>
      ))}
    </div>
  );
}

/** Rounded queue tabs as in the mock (.tabs / .tab). */
export function Tabs<T extends string>({ value, options, onChange, label }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="tabs" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.v} type="button" className={`tab${o.v === value ? ' on' : ''}`} aria-pressed={o.v === value} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
