/** Check-in escalation rules (design 6.4). Pure. */
export const BOOST_PER_MISS = 10;
export const MAX_SCORE = 100;
export const MAX_WINDOW_MULTIPLIER = 8;

/** Response window for attempt n (1-based): the base interval doubles per attempt, capped. */
export function windowSeconds(baseS: number, attempt: number): number {
  return baseS * Math.min(2 ** Math.max(0, attempt - 1), MAX_WINDOW_MULTIPLIER);
}

/** +10 per missed attempt, capped at 100; priority never decreases. */
export function escalate(score: number): number {
  return Math.max(score, Math.min(MAX_SCORE, score + BOOST_PER_MISS));
}

/** First check-in is due `interval` after the case arrived; later ones `interval` after the last response. */
export function nextDueAt(baseS: number, receivedAt: Date, lastRespondedAt: Date | null): Date {
  return new Date((lastRespondedAt ?? receivedAt).getTime() + baseS * 1000);
}

/** Final score = triage score + accumulated silence boosts, capped. */
export const withBoosts = (triageScore: number, ...boosts: number[]) => Math.min(MAX_SCORE, triageScore + boosts.reduce((a, b) => a + b, 0));
