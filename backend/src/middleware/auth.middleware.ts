import { Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt';
import { query } from '../config/database';
import { AuthenticatedRequest, UserRole } from '../types';
import { sendError } from '../utils/response';
import { logger } from '../utils/logger';

export const protect = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    sendError(res, 'Unauthorized — no token provided', 401);
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const payload = verifyAccessToken(token);
    const { rows } = await query<Pick<import('../types').User, 'id' | 'name' | 'email' | 'role' | 'avatar_url'>>(
      'SELECT id, name, email, role, avatar_url, google_id, created_at FROM users WHERE id = $1',
      [payload.userId]
    );

    if (!rows[0]) {
      sendError(res, 'Unauthorized — user not found', 401);
      return;
    }

    req.user = rows[0];
    logger.info(`[AUTH] ${rows[0].role} "${rows[0].email}" accessed ${req.method} ${req.path}`);
    next();
  } catch {
    sendError(res, 'Unauthorized — invalid or expired token', 401);
  }
};

// Role guard — use after protect()
export const requireRole = (...roles: UserRole[]) =>
  (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      sendError(res, 'Unauthorized', 401);
      return;
    }
    if (!roles.includes(req.user.role)) {
      logger.warn(`[ROLE] Forbidden: ${req.user.role} tried to access ${req.method} ${req.path}`);
      sendError(res, 'Forbidden — insufficient permissions', 403);
      return;
    }
    next();
  };
