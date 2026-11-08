import type { Sos } from '../api/models';
import { CRITICAL_MIN, shortId } from './tier';
import { formatAge } from './time';

export interface Escalation {
  caseId: string;
  kind: 'silent' | 'critical';
  at: string;
  text: string;
}

/** The most recent thing a dispatcher should look at: a case that went silent or a new critical case. Driven only by live data. */
export function latestEscalation(cases: Sos[], now = Date.now()): Escalation | null {
  let best: Escalation | null = null;
  for (const c of cases) {
    if (c.status === 'resolved' || c.status === 'closed' || c.status === 'merged') continue;
    const cands: Escalation[] = [];
    if (c.silent) {
      const at = c.silent_since ?? c.last_heard_at;
      cands.push({ caseId: c.id, kind: 'silent', at, text: `${shortId(c.id)} went silent ${formatAge(at, now)}, score ${c.score}` });
    }
    if (c.score >= CRITICAL_MIN && !c.assignment) {
      const at = c.received_at ?? c.created_at;
      cands.push({ caseId: c.id, kind: 'critical', at, text: `${shortId(c.id)} critical (${c.score}), unclaimed, received ${formatAge(at, now)}` });
    }
    for (const e of cands) if (!best || Date.parse(e.at) > Date.parse(best.at)) best = e;
  }
  return best;
}
