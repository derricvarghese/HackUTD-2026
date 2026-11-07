import type { Ctx, DeviceAuth } from '../ctx';
import type { Viewer } from '../domain/privacy';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      responder?: { id: string; role: 'responder' | 'volunteer' | 'admin'; name: string };
      device?: DeviceAuth;
      ctx: Ctx;
      authError?: import('../errors').AppError;
    }
  }
}

import type { Request } from 'express';
import { forbidden, unauthorized } from '../errors';

export function viewerOf(req: Request): Viewer {
  if (req.responder) return { kind: 'responder', id: req.responder.id, role: req.responder.role };
  if (req.device) return { kind: 'device', id: req.device.id };
  return { kind: 'anon' };
}
export function requireResponder(req: Request) {
  if (!req.responder) throw unauthorized('Responder login required');
  return req.responder;
}
export function requireDevice(req: Request) {
  if (!req.device) throw unauthorized('Device signature required');
  return req.device;
}
export function requireRole(req: Request, ...roles: Array<'responder' | 'volunteer' | 'admin'>) {
  const r = requireResponder(req);
  if (!roles.includes(r.role)) throw forbidden('Insufficient role');
  return r;
}
