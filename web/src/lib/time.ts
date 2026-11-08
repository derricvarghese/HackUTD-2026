export const MIN = 60_000;
export const HOUR = 60 * MIN;

/** "just now", "2 min ago", "3 h ago", "2 d ago". Future or invalid dates read as "just now"/"-". */
export function formatAge(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '-';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '-';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** Duration in seconds as "41 s", "12 min", "1 h 05 min". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '-';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} h ${String(rm).padStart(2, '0')} min` : `${h} h`;
}

/** Minutes silent for a case: from silent_since, falling back to last_heard_at. */
export function silentForMinutes(c: { silent?: boolean; silent_since?: string | null; last_heard_at: string }, now = Date.now()): number | null {
  if (!c.silent) return null;
  const from = Date.parse(c.silent_since ?? c.last_heard_at);
  if (Number.isNaN(from)) return null;
  return Math.max(0, Math.round((now - from) / MIN));
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Seconds to a friendly TTL label: 86400 -> "24 h", 1800 -> "30 min". */
export function formatTtl(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}
