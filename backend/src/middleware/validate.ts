import { Request, Response, NextFunction } from 'express';
import { validationResult } from 'express-validator';
import { sendError } from '../utils/response';

export const validate = (req: Request, res: Response, next: NextFunction): void => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const formatted = errors.array().map((e) => ({
      field: 'path' in e ? String(e.path) : 'unknown',
      message: e.msg,
    }));
    sendError(res, 'Validation failed', 422, formatted);
    return;
  }
  next();
};
