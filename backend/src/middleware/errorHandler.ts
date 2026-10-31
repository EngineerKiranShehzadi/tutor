import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { logger } from '../utils/logger';
import { sendError } from '../utils/response';
import { env } from '../config/env';
import { classifyErrorCode } from '../observability/tracer';
import { logSafeText } from '../observability/sanitize';

export class AppError extends Error {
  constructor(public message: string, public statusCode: number) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }
}

// How an unexpected error is written to the log (A18). Its message can carry
// user content (a DB error quoting a student's question, a library echoing
// input), so by default only a stable code, the error's type and a
// content-safe form of the message are logged — the same rule as every other
// log line (logSafeText: the text itself only when content capture is on).
// The raw message and stack are added when LOG_ERROR_DETAILS is on (default:
// on outside production, off in production).
export function describeError(err: unknown): { line: string; details?: { message: string; stack?: string } } {
  const e = err as Error | undefined;
  const line = `code=${classifyErrorCode(err)} type=${e?.name ?? typeof err} message=${logSafeText(String(e?.message ?? err), 120)}`;
  return env.LOG_ERROR_DETAILS ? { line, details: { message: String(e?.message ?? err), stack: e?.stack } } : { line };
}

const MB = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  if (err instanceof AppError) {
    logger.warn(`[ERROR] ${err.statusCode} ${req.method} ${req.path} — ${err.message}`);
    sendError(res, err.message, err.statusCode);
    return;
  }

  // Upload problems are the client's, not the server's (A16).
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `The file is too large (the limit is ${MB(env.DATASET.MAX_UPLOAD_BYTES)}).`
      : `Upload rejected: ${err.message}.`;
    logger.warn(`[ERROR] ${status} ${req.method} ${req.path} — multer ${err.code}`);
    sendError(res, message, status);
    return;
  }

  // body-parser and similar raise http-errors with a 4xx status and
  // expose=true (malformed JSON, body too large): answer with that status.
  const httpErr = err as Error & { status?: number; statusCode?: number; expose?: boolean; type?: string };
  const status = httpErr.status ?? httpErr.statusCode;
  if (httpErr.expose === true && typeof status === 'number' && status >= 400 && status < 500) {
    const message = status === 413 ? 'The request body is too large.' : 'The request could not be read.';
    logger.warn(`[ERROR] ${status} ${req.method} ${req.path} — ${httpErr.type ?? 'client error'}`);
    sendError(res, message, status);
    return;
  }

  const d = describeError(err);
  logger.error(`[ERROR] 500 ${req.method} ${req.path} — ${d.line}`, d.details ?? {});
  sendError(res, 'Internal server error', 500);
};

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
