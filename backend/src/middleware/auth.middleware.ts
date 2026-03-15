import { Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt';
import { query } from '../config/database';
import { AuthenticatedRequest } from '../types';
import { sendError } from '../utils/response';

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
    const { rows } = await query(
      'SELECT id, name, email FROM users WHERE id = $1',
      [payload.userId]
    );

    if (!rows[0]) {
      sendError(res, 'Unauthorized — user not found', 401);
      return;
    }

    req.user = rows[0];
    next();
  } catch {
    sendError(res, 'Unauthorized — invalid or expired token', 401);
  }
};
