/** In-memory token bucket keyed by string. Pure given an injected clock. */
export class TokenBuckets {
  private b = new Map<string, { tokens: number; at: number }>();
  constructor(private capacity: number, private refillPerSec: number) {}
  take(key: string, now = Date.now(), cost = 1): { ok: boolean; retryAfterS: number } {
    const cur = this.b.get(key) ?? { tokens: this.capacity, at: now };
    const tokens = Math.min(this.capacity, cur.tokens + ((now - cur.at) / 1000) * this.refillPerSec);
    if (tokens >= cost) {
      this.b.set(key, { tokens: tokens - cost, at: now });
      return { ok: true, retryAfterS: 0 };
    }
    this.b.set(key, { tokens, at: now });
    return { ok: false, retryAfterS: Math.max(1, Math.ceil((cost - tokens) / this.refillPerSec)) };
  }
  sweep(now = Date.now()) {
    for (const [k, v] of this.b) if (now - v.at > (this.capacity / this.refillPerSec) * 1000) this.b.delete(k);
  }
}
