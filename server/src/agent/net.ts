import type { Ctx } from '../ctx';

/**
 * Privacy + transport layer of the dispatch agent. EVERY external HTTP call goes through `extHttp`, which refuses any URL or body that
 * carries a coordinate with more than 3 decimals (~110 m). Tools build their requests from a `Coarse` point, never from the case row.
 */
export const UA = 'BeaconHackUTD/1.0 (hackutd.alecj.com)';
export const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface Coarse { lat: number; lng: number }
export const coarse = (lat: number, lng: number): Coarse => ({ lat: round3(lat), lng: round3(lng) });

/** A decimal number with 4+ fraction digits looks like a precise coordinate. */
const PRECISE = /-?\d{1,3}\.\d{4,}/;
export class PrivacyError extends Error {}
export function assertCoarse(s: string) {
  if (PRECISE.test(s)) throw new PrivacyError('refusing to send a coordinate with more than 3 decimals');
}

export class ToolError extends Error {}

export interface HttpOpts { method?: 'GET' | 'POST'; body?: string; headers?: Record<string, string>; timeoutMs: number; signal?: AbortSignal }
export interface HttpRes { status: number; text: string; json<T = any>(): T }

/** The one wrapper for outbound requests. */
export async function extHttp(ctx: Ctx, url: string, o: HttpOpts): Promise<HttpRes> {
  if (!ctx.cfg.AGENT_EXTERNAL_TOOLS) throw new ToolError('external tools disabled');
  assertCoarse(decodeURIComponent(url));
  if (o.body) assertCoarse(decodeURIComponent(o.body.replace(/\+/g, ' ')));
  const f = ctx.fetch ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs);
  const onAbort = () => ac.abort();
  o.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await f(url, { method: o.method ?? 'GET', body: o.body, headers: { 'User-Agent': UA, ...o.headers }, signal: ac.signal });
    const text = await res.text();
    return { status: res.status, text, json: <T>() => JSON.parse(text) as T };
  } catch (e) {
    if (e instanceof PrivacyError) throw e;
    throw new ToolError(ac.signal.aborted ? 'timeout' : `network error: ${(e as Error).message.slice(0, 80)}`);
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onAbort);
  }
}

/** Per-process TTL cache with a size cap. */
export class TtlCache {
  private m = new Map<string, { at: number; v: unknown }>();
  constructor(private max = 500) {}
  get<T>(k: string, ttlMs: number, now = Date.now()): T | undefined {
    const h = this.m.get(k);
    if (!h) return undefined;
    if (now - h.at > ttlMs) { this.m.delete(k); return undefined; }
    return h.v as T;
  }
  set(k: string, v: unknown, now = Date.now()) {
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value as string);
    this.m.set(k, { at: now, v });
  }
}

/** Serialises calls and keeps at least `minMs` between their starts (Nominatim: 1 request per second). */
export class Limiter {
  private tail: Promise<unknown> = Promise.resolve();
  private last = 0;
  constructor(private minMs: number) {}
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(async () => {
      const wait = this.last + this.minMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      return fn();
    });
    this.tail = p.catch(() => {});
    return p;
  }
}

export interface Runtime { cache: TtlCache; nominatim: Limiter }
const rts = new WeakMap<Ctx, Runtime>();
export function runtimeOf(ctx: Ctx): Runtime {
  let r = rts.get(ctx);
  if (!r) { r = { cache: new TtlCache(), nominatim: new Limiter(ctx.cfg.NODE_ENV === 'test' ? 120 : 1100) }; rts.set(ctx, r); }
  return r;
}

// ------------------------------------------------------------------------------ untrusted data handling

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
export const stripControl = (s: string) => s.replace(CONTROL, ' ');
export const clip = (s: unknown, n: number) => { const t = stripControl(String(s ?? '')).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** Removes phone numbers, e-mail addresses and precise coordinates from model-written text before it is stored or broadcast. */
export function scrubText(s: string): string {
  return stripControl(s)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/-?\d{1,3}\.\d{4,}/g, '[coordinate]')
    .replace(/\+?\d[\d\s().-]{8,}\d/g, '[number]');
}

/** Delimited data block handed to the model as a tool message. Content is data, never instructions. */
export function wrapToolResult(name: string, result: unknown, maxChars = 2500): string {
  let body = stripControl(JSON.stringify(result) ?? 'null');
  if (body.length > maxChars) body = `${body.slice(0, maxChars)}…[truncated]`;
  body = body.replace(/<\/?tool_result/gi, '<\\/tool_result');
  return `<tool_result name="${name}" trust="untrusted-data">\n${body}\n</tool_result>`;
}
