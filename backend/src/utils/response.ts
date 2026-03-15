import { Response } from 'express';
import { ApiResponse } from '../types';

export const sendSuccess = <T>(
  res: Response,
  message: string,
  data?: T,
  statusCode = 200
): Response =>
  res.status(statusCode).json({ success: true, message, data } as ApiResponse<T>);

export const sendError = (
  res: Response,
  message: string,
  statusCode = 400,
  errors?: Record<string, string>[]
): Response =>
  res.status(statusCode).json({ success: false, message, errors } as ApiResponse);
