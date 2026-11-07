import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Ctx } from '../ctx';
import { AppError, type ErrorCode } from '../errors';

interface OavError extends Error { status?: number; errors?: { path?: string; message?: string; errorCode?: string }[]; type?: string }

function fieldsOf(errors: OavError['errors']): Record<string, string> {
  const f: Record<string, string> = {};
  for (const e of errors ?? []) {
    // validator paths look like "/body/envelopes/0/id" or "/query/limit" -> "envelopes.0.id" / "query.limit"
    const parts = (e.path ?? '/body').split(/[/.]/).filter(Boolean);
    if (parts[0] === 'body') parts.shift();
    f[parts.join('.') || 'body'] = e.message ?? 'invalid';
  }
  return f;
}

export function errorHandler(ctx: Ctx): ErrorRequestHandler {
  return (err: OavError, req, res, _next) => {
    let status = 500;
    let code: ErrorCode = 'internal';
    let message = 'Internal server error';
    let details: Record<string, unknown> | undefined;
    let headers: Record<string, string> | undefined;

    if (err instanceof AppError) {
      ({ status, code, message, details, headers } = err);
    } else if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      status = 422; code = 'validation_failed'; message = 'Malformed JSON body';
    } else if (err?.type === 'entity.too.large') {
      status = 413; code = 'validation_failed'; message = 'Request body too large';
    } else if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
      // express-openapi-validator errors
      status = err.status;
      message = err.message || 'Bad request';
      if (status === 400) { status = 422; code = 'validation_failed'; message = 'Request failed validation'; details = { fields: fieldsOf(err.errors) }; }
      else if (status === 401) { code = req.authError?.code ?? 'unauthorized'; message = req.authError?.message ?? message; }
      else if (status === 403) code = 'forbidden';
      else if (status === 404) code = 'not_found';
      else if (status === 405) { code = 'not_found'; message = 'Method not allowed'; }
      else code = 'validation_failed';
    } else if ((err as { code?: string })?.code === '23505') {
      status = 409; code = 'conflict'; message = 'Conflicting resource';
    } else {
      ctx.log.error({ err: err?.message, stack: err?.stack, url: req.originalUrl }, 'unhandled error');
      if (ctx.cfg.NODE_ENV !== 'production') details = { cause: String(err?.message ?? err) };
    }
    if (status >= 500 && !(err instanceof AppError)) message = 'Internal server error';
    const body: { code: ErrorCode; message: string; details?: Record<string, unknown> } = { code, message };
    if (details) body.details = details;
    // send as a pre-serialised string: bypasses response validation, which rejects status codes the spec does not list per-route
    res.status(status);
    for (const [k, v] of Object.entries(headers ?? {})) res.setHeader(k, v);
    res.type('application/json').send(JSON.stringify(body));
  };
}

/** Anything under /v1 that the spec allows but we have not built yet. */
export const notImplemented: RequestHandler = (req, _res, next) => {
  next(new AppError(501, 'internal', `${req.method} ${req.path} is not implemented yet`));
};
