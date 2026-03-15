import { Request, Response } from 'express';
import { body } from 'express-validator';
import * as AuthService from '../services/auth.service';
import { sendSuccess, sendError } from '../utils/response';
import { asyncHandler } from '../middleware/errorHandler';
import { AuthenticatedRequest } from '../types';
import { env } from '../config/env';

const COOKIE_OPTS = {
  httpOnly: true,
  secure:   env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  maxAge:   7 * 24 * 60 * 60 * 1000,
};

// ── Validators ────────────────────────────────────────
export const registerValidators = [
  body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 100 }),
  body('email').isEmail().withMessage('Valid email required').normalizeEmail(),
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Password must contain an uppercase letter')
    .matches(/[0-9]/).withMessage('Password must contain a number'),
];

export const loginValidators = [
  body('email').isEmail().withMessage('Valid email required').normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required'),
];

export const forgotPasswordValidators = [
  body('email').isEmail().withMessage('Valid email required').normalizeEmail(),
];

export const resetPasswordValidators = [
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Must contain an uppercase letter')
    .matches(/[0-9]/).withMessage('Must contain a number'),
];

// ── Controllers ───────────────────────────────────────
export const register = asyncHandler(async (req: Request, res: Response) => {
  const { name, email, password } = req.body;
  const { user, accessToken, refreshToken } = await AuthService.registerUser(name, email, password);
  res.cookie('refreshToken', refreshToken, COOKIE_OPTS);
  sendSuccess(res, 'Account created successfully', { user, accessToken }, 201);
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body;
  const { user, accessToken, refreshToken } = await AuthService.loginUser(email, password);
  res.cookie('refreshToken', refreshToken, COOKIE_OPTS);
  sendSuccess(res, 'Logged in successfully', { user, accessToken });
});

export const refreshToken = asyncHandler(async (req: Request, res: Response) => {
  const token = req.cookies?.refreshToken;
  if (!token) { sendError(res, 'No refresh token', 401); return; }
  const tokens = await AuthService.refreshAccessToken(token);
  res.cookie('refreshToken', tokens.refreshToken, COOKIE_OPTS);
  sendSuccess(res, 'Token refreshed', { accessToken: tokens.accessToken });
});

export const logout = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const token = req.cookies?.refreshToken;
  if (req.user && token) await AuthService.logoutUser(req.user.id, token);
  res.clearCookie('refreshToken');
  sendSuccess(res, 'Logged out successfully');
});

export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  await AuthService.forgotPassword(req.body.email);
  sendSuccess(res, 'If that email exists, a reset link has been sent.');
});

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const { token } = req.params;
  const { password } = req.body;
  await AuthService.resetPassword(token, password);
  res.clearCookie('refreshToken');
  sendSuccess(res, 'Password reset successfully. Please log in.');
});

export const getMe = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  sendSuccess(res, 'User fetched', req.user);
});
