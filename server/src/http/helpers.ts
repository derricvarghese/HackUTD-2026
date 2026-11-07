import type { Request } from 'express';

export const asList = (v: unknown): string[] | undefined => {
  if (v === undefined || v === '') return undefined;
  return (Array.isArray(v) ? v : String(v).split(',')).map(String).filter(Boolean);
};
export const asInt = (v: unknown, d: number) => (v === undefined || v === '' ? d : Number(v));
export const asBool = (v: unknown): boolean | undefined => (v === undefined || v === '' ? undefined : v === true || v === 'true');
export const q = (req: Request) => req.query as Record<string, unknown>;
export const limitOf = (req: Request) => Math.min(200, Math.max(1, asInt(q(req).limit, 50)));
export const str = (v: unknown) => (v === undefined || v === '' ? undefined : String(v));
