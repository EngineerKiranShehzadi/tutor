import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import { env } from '../config/env';
import { sendError } from '../utils/response';
import { logger } from '../utils/logger';
import { verifyAccessToken } from '../utils/jwt';

// Anonymous traffic is limited per IP (globalLimiter); authenticated traffic
// per user (userLimiter). One shared per-IP bucket let an admin's own build
// polling exhaust it and then 429 the Cancel button, and put every student
// behind one campus NAT in the same bucket.

// The user id from a valid access token, or null. Cached on res.locals so both
// limiters verify the JWT at most once. An invalid/expired token is anonymous
// here; protect() still rejects it later.
export const bearerUserId = (req: Request, res: Response): string | null => {
  if (res.locals.rlUserId !== undefined) return res.locals.rlUserId as string | null;
  const h = req.headers.authorization;
  let id: string | null = null;
  if (h?.startsWith('Bearer ')) {
    try { id = verifyAccessToken(h.slice(7)).userId ?? null; } catch { id = null; }
  }
  res.locals.rlUserId = id;
  return id;
};

export const globalLimiter = rateLimit({
  windowMs: env.RATE_LIMIT.WINDOW_MS,
  max:      env.RATE_LIMIT.MAX,
  skip:     (req, res) => bearerUserId(req, res) !== null,
  handler:  (req, res) => {
    logger.warn(`[RATE LIMIT] 429 global limit hit — IP=${req.ip ?? 'unknown'} path=${req.path}`);
    sendError(res, 'Too many requests, please try again later.', 429);
  },
  standardHeaders: true,
  legacyHeaders:   false,
});

// Authenticated callers, keyed by user id. Chat cost stays bounded by the
// per-student ask quota (ask-quota.service.ts), which this does not touch.
export const userLimiter = rateLimit({
  windowMs:     env.RATE_LIMIT.WINDOW_MS,
  max:          env.RATE_LIMIT.USER_MAX,
  keyGenerator: (req, res) => `u:${bearerUserId(req, res)}`,
  skip:         (req, res) => bearerUserId(req, res) === null,
  handler:      (req, res) => {
    logger.warn(`[RATE LIMIT] 429 user limit hit — path=${req.path}`);
    sendError(res, 'Too many requests, please try again later.', 429);
  },
  standardHeaders: true,
  legacyHeaders:   false,
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      env.RATE_LIMIT.AUTH_MAX,
  handler:  (req, res) => {
    logger.warn(`[RATE LIMIT] 429 auth limit hit — IP=${req.ip ?? 'unknown'} path=${req.path}`);
    sendError(res, 'Too many auth attempts. Please wait 15 minutes.', 429);
  },
  standardHeaders: true,
  legacyHeaders:   false,
});
