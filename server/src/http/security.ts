import type { Request } from 'express';
import type { Ctx } from '../ctx';
import { deviceRequestMessage, verifyEcdsa } from '../crypto/verify';
import { AppError, unauthorized } from '../errors';

/** The validator flattens handler errors to a generic 401; remember the precise AppError so the error handler can restore its `code`. */
function fail(req: Request, e: AppError, present: boolean): never {
  if (present) req.authError = e;
  throw e;
}
import { verifyAccess } from '../services/auth';
import { loadDeviceAuth, touchDevice } from '../services/devices';

const MAX_SKEW_MS = 5 * 60 * 1000;

/** X-Timestamp may be RFC 3339, epoch seconds or epoch milliseconds; the raw header text is what gets signed. */
export function parseTimestamp(v: string): number | null {
  if (/^\d{9,16}$/.test(v)) { const n = Number(v); return n < 1e12 ? n * 1000 : n; }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Path signed by devices: the request path as sent (with the /v1 prefix), without the query string. */
export const signedPath = (req: Request) => (req.originalUrl || req.url).split('?')[0];

/** express-openapi-validator security handlers (the spec's `security` alternatives are OR-ed by the validator). */
export function securityHandlers(ctx: Ctx) {
  return {
    responderJwt: async (req: Request) => {
      const h = req.headers.authorization;
      if (!h || !/^Bearer /i.test(h)) throw unauthorized('Bearer token required');
      const claims = verifyAccess(ctx, h.slice(7).trim());
      if (!claims) fail(req, unauthorized('Invalid or expired access token'), true);
      req.responder = { id: claims.sub, role: claims.role, name: claims.name };
      return true;
    },
    deviceSignature: async (req: Request) => {
      const id = req.header('x-device-id');
      const ts = req.header('x-timestamp');
      const sig = req.header('x-device-signature');
      if (!id || !ts || !sig) fail(req, unauthorized('X-Device-Id, X-Timestamp and X-Device-Signature are required'), !!sig);
      const t = parseTimestamp(ts!);
      if (t == null) fail(req, unauthorized('Bad X-Timestamp'), true);
      if (Math.abs(Date.now() - t!) > MAX_SKEW_MS) fail(req, new AppError(401, 'expired', 'X-Timestamp skew is more than 5 minutes'), true);
      if (!/^[0-9a-f-]{36}$/i.test(id!)) fail(req, unauthorized('Unknown device'), true);
      const dev = await loadDeviceAuth(ctx, id!);
      if (!dev) fail(req, unauthorized('Unknown device'), true);
      const msg = deviceRequestMessage(req.method, signedPath(req), req.rawBody ?? Buffer.alloc(0), ts!);
      if (!verifyEcdsa(dev!.publicKey, msg, sig!)) fail(req, new AppError(401, 'bad_signature', 'Device signature does not verify'), true);
      req.device = dev!;
      touchDevice(ctx, dev!.id);
      return true;
    },
  };
}
