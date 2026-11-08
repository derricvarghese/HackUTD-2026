// Pure helpers for the AI triage lifecycle: provisional rules score first, AI result later (sos.updated).
import type { Sos, TriageReason } from '../api/models';

export type TriageStatus = Sos['triage_status'];

export interface TriageInfo {
  /** pending = rules score only so far; failed = AI gave up (retried by a slow sweep); done = AI applied; unknown = field missing (older server) */
  state: 'pending' | 'failed' | 'done' | 'unknown';
  label: string;
  tooltip: string;
}

export const PENDING_TOOLTIP = 'Provisional score from rules; AI is still analysing';
export const FAILED_TOOLTIP = 'AI unavailable, rules only. The server retries automatically.';

export function triageInfo(status: TriageStatus | null | undefined): TriageInfo {
  switch (status) {
    case 'provisional':
      return { state: 'pending', label: 'AI pending', tooltip: PENDING_TOOLTIP };
    case 'pending':
      return { state: 'pending', label: 'AI analysing', tooltip: PENDING_TOOLTIP };
    case 'failed':
      return { state: 'failed', label: 'AI unavailable, rules only', tooltip: FAILED_TOOLTIP };
    case 'complete':
      return { state: 'done', label: 'AI scored', tooltip: 'Score confirmed by the AI read of the message' };
    default:
      return { state: 'unknown', label: '', tooltip: '' };
  }
}

/** Should the score badge carry a marker (pending dot / failed note)? Nothing special once complete. */
export const hasTriageMarker = (status: TriageStatus | null | undefined): boolean => {
  const s = triageInfo(status).state;
  return s === 'pending' || s === 'failed';
};

export interface ScoreChange {
  from: number;
  to: number;
  delta: number;
  at: number;
}

/** A provisional/pending case that turned complete: what the AI did to the score. */
export function scoreChange(prev: Pick<Sos, 'score' | 'triage_status'> | undefined, next: Pick<Sos, 'score' | 'triage_status'>, at = Date.now()): ScoreChange | null {
  if (!prev || next.triage_status !== 'complete') return null;
  if (prev.triage_status !== 'provisional' && prev.triage_status !== 'pending') return null;
  return { from: prev.score, to: next.score, delta: next.score - prev.score, at };
}

export function describeScoreChange(ch: Pick<ScoreChange, 'from' | 'to' | 'delta'>): string {
  return ch.delta === 0 ? `AI confirmed ${ch.to}` : `AI adjusted ${ch.from} → ${ch.to}`;
}

/** Frames can arrive out of order (or a refetch can be newer than a frame): never let an older version overwrite a newer one. */
export function isStaleFrame(existing: { version?: number } | undefined, incoming: { version?: number }): boolean {
  if (!existing || existing.version === undefined || incoming.version === undefined) return false;
  return incoming.version < existing.version;
}

export type ReasonGroupKey = 'rule' | 'llm' | 'contact' | 'manual';

export const REASON_GROUP_LABEL: Record<ReasonGroupKey, string> = {
  rule: 'Rule reasons',
  llm: 'AI reasons',
  contact: 'Contact and welfare',
  manual: 'Manual',
};

export const REASON_SOURCE_LABEL: Record<TriageReason['source'], string> = {
  rule: 'Rule',
  llm: 'AI',
  silence: 'Lost contact / missed check-ins',
  heartbeat: 'Heartbeat stopped',
  checkin: 'Asked for urgent help',
  manual: 'Manual',
};

export const reasonGroupOf = (r: Pick<TriageReason, 'source'>): ReasonGroupKey =>
  r.source === 'rule' ? 'rule' : r.source === 'llm' ? 'llm' : r.source === 'manual' ? 'manual' : 'contact';

/** Reasons split by where they came from, empty groups dropped. Rules first, then the AI, then contact signals. */
export function groupReasons(reasons: TriageReason[]): { key: ReasonGroupKey; label: string; items: TriageReason[] }[] {
  const order: ReasonGroupKey[] = ['rule', 'llm', 'contact', 'manual'];
  return order
    .map((key) => ({ key, label: REASON_GROUP_LABEL[key], items: reasons.filter((r) => reasonGroupOf(r) === key) }))
    .filter((g) => g.items.length > 0);
}

/** Backlog from /health: null when there is nothing waiting. */
export function aiBacklog(t: { queue_depth?: number; oldest_pending_seconds?: number } | undefined): { depth: number; oldestSeconds: number } | null {
  const depth = t?.queue_depth ?? 0;
  if (depth <= 0) return null;
  return { depth, oldestSeconds: Math.max(0, t?.oldest_pending_seconds ?? 0) };
}
