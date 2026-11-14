import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { extractBearer } from '../../../../packages/auth/src/apiKey';
import { AppError, toErrorBody } from '../../../../packages/shared/src/errors';
import type { Deps } from '../types';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

/** Accepts a well-formed client X-Request-ID, otherwise generates one. Always echoed in the response. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  const id = incoming && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-ID', id);
  next();
};

/** Wraps async handlers so rejections reach the central error handler (Express 4 does not). */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { void fn(req, res, next).catch(next); };

export function requireApiKey(deps: Deps): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    const key = extractBearer(req.header('authorization'));
    const ctx = key ? await deps.apiKeys.authenticate(key) : null;
    if (!ctx) throw new AppError(401, 'authentication_error', 'INVALID_API_KEY', 'Invalid or missing API key');
    res.locals.auth = ctx;
    next();
  });
}

const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

/** Admin endpoints (/api/*) are protected by a static bearer token, compared in constant time. */
export function requireAdmin(deps: Deps): RequestHandler {
  const expected = sha(deps.cfg.ADMIN_API_TOKEN);
  return (req, _res, next) => {
    const presented = extractBearer(req.header('authorization'));
    if (!presented || !timingSafeEqual(sha(presented), expected)) {
      return next(new AppError(401, 'authentication_error', 'INVALID_ADMIN_TOKEN', 'Invalid or missing admin token'));
    }
    next();
  };
}

export function notFound(): RequestHandler {
  return (_req, _res, next) => next(new AppError(404, 'invalid_request_error', 'NOT_FOUND', 'Route not found'));
}

/** Central error handler: never leaks stack traces, upstream bodies, or internals. */
export function errorHandler(deps: Deps) {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    const rid = res.locals.requestId;
    let app: AppError;
    const e = err as { type?: string; status?: number };
    if (err instanceof AppError) app = err;
    else if (e?.type === 'entity.too.large')
      app = new AppError(413, 'invalid_request_error', 'REQUEST_TOO_LARGE', 'Request body too large');
    else if (err instanceof SyntaxError && e?.status === 400)
      app = new AppError(400, 'invalid_request_error', 'INVALID_JSON', 'Request body is not valid JSON');
    else {
      deps.log.error({ requestId: rid, err }, 'unhandled error');
      app = new AppError(500, 'internal_error', 'INTERNAL_ERROR', 'Internal server error');
    }
    res.locals.errorCode = app.code;
    if (res.headersSent) { res.end(); return; }
    res.status(app.status).json(toErrorBody(app, rid));
  };
}
