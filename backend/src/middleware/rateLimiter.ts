import rateLimit from 'express-rate-limit';
import { env } from '../config/env';
import { sendError } from '../utils/response';
import { logger } from '../utils/logger';

export const globalLimiter = rateLimit({
  windowMs: env.RATE_LIMIT.WINDOW_MS,
  max:      env.RATE_LIMIT.MAX,
  handler:  (req, res) => {
    logger.warn(`[RATE LIMIT] 429 global limit hit — IP=${req.ip ?? 'unknown'} path=${req.path}`);
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
