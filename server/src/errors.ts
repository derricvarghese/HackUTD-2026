export type ErrorCode =
  | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'validation_failed'
  | 'rate_limited' | 'bad_signature' | 'expired' | 'internal';

/** Thrown anywhere; the error handler maps it to the `Error` schema. */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public details?: Record<string, unknown>,
    public headers?: Record<string, string>,
  ) {
    super(message);
  }
}
export const unauthorized = (m = 'Missing or invalid credentials') => new AppError(401, 'unauthorized', m);
export const forbidden = (m = 'Not allowed') => new AppError(403, 'forbidden', m);
export const notFound = (m = 'Not found') => new AppError(404, 'not_found', m);
export const conflict = (m: string, details?: Record<string, unknown>) => new AppError(409, 'conflict', m, details);
export const invalid = (m: string, fields?: Record<string, string>) =>
  new AppError(422, 'validation_failed', m, fields ? { fields } : undefined);
export const tooMany = (retryAfterS: number) =>
  new AppError(429, 'rate_limited', 'Too many requests', undefined, { 'Retry-After': String(retryAfterS) });
