// Small typed fetch client for the Beacon API (same-origin, relative /v1 URLs).
import type { components, paths } from './types';

export const API_BASE = '/v1';

export type Schemas = components['schemas'];

type Json<T> = T extends { content: { 'application/json': infer J } } ? J : never;
/** JSON response body of operation M on path P with status S (default 200). */
export type Res<P extends keyof paths, M extends keyof paths[P], S extends string | number = 200> = paths[P][M] extends { responses: infer R }
  ? S extends keyof R
    ? Json<R[S]>
    : never
  : never;
/** JSON request body. */
export type Body<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends { requestBody?: infer B }
  ? Json<NonNullable<B>>
  : never;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
  get isConflict() {
    return this.status === 409;
  }
  get isNotFound() {
    return this.status === 404;
  }
}

export interface ClientHooks {
  getToken: () => string | null;
  /** Refresh the session; resolves true when a fresh access token is available. */
  refresh: () => Promise<boolean>;
  /** Called when the session is definitively lost (refresh failed). */
  onSessionLost: () => void;
}

let hooks: ClientHooks = { getToken: () => null, refresh: async () => false, onSessionLost: () => undefined };
export function configureClient(h: ClientHooks) {
  hooks = h;
}

export type QueryValue = string | number | boolean | string[] | undefined | null;
export type Query = Record<string, QueryValue>;

/** Serialises a query object. Arrays are comma separated (OpenAPI form, explode=false); empty values are dropped. */
export function buildQueryString(q?: Query): string {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length) p.set(k, v.join(','));
    } else p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export interface RequestOpts {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  /** Skip the bearer token (login / refresh). */
  anonymous?: boolean;
  /** Raw body (e.g. audio); skips JSON encoding. */
  rawBody?: BodyInit;
  contentType?: string;
}

async function toApiError(res: Response): Promise<ApiError> {
  let code = 'internal';
  let message = res.statusText || `HTTP ${res.status}`;
  let details: Record<string, unknown> | undefined;
  try {
    const j = (await res.json()) as Partial<Schemas['Error']>;
    if (j.code) code = j.code;
    if (j.message) message = j.message;
    details = j.details as Record<string, unknown> | undefined;
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, code, message, details);
}

async function send(method: string, path: string, o: RequestOpts, token: string | null): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (o.rawBody !== undefined) {
    body = o.rawBody;
    if (o.contentType) headers['Content-Type'] = o.contentType;
  } else if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers['Content-Type'] = 'application/json';
  }
  if (token && !o.anonymous) headers.Authorization = `Bearer ${token}`;
  try {
    return await fetch(`${API_BASE}${path}${buildQueryString(o.query)}`, { method, headers, body, signal: o.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'Cannot reach the Beacon server');
  }
}

export async function requestRaw(method: string, path: string, o: RequestOpts = {}): Promise<Response> {
  let res = await send(method, path, o, hooks.getToken());
  if (res.status === 401 && !o.anonymous) {
    if (await hooks.refresh()) res = await send(method, path, o, hooks.getToken());
    if (res.status === 401) {
      hooks.onSessionLost();
    }
  }
  if (!res.ok) throw await toApiError(res);
  return res;
}

export async function request<T>(method: string, path: string, o: RequestOpts = {}): Promise<T> {
  const res = await requestRaw(method, path, o);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const http = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>('GET', path, { query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body }),
  del: (path: string) => request<void>('DELETE', path),
};
