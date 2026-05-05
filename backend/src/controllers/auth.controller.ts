import { Request, Response } from 'express';
import { body } from 'express-validator';
import * as AuthService from '../services/auth.service';
import { sendSuccess, sendError } from '../utils/response';
import { asyncHandler } from '../middleware/errorHandler';
import { AuthenticatedRequest } from '../types';
import { env } from '../config/env';
import { logger } from '../utils/logger';

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

export const resendLoginOtpValidators = [
  body('email').isEmail().withMessage('Valid email required').normalizeEmail(),
];

// ── Controllers ───────────────────────────────────────
export const register = asyncHandler(async (req: Request, res: Response) => {
  const { name, email, password } = req.body;
  logger.info(`[AUTH] Register attempt: name="${name}" email="${email}"`);
  const { user, accessToken, refreshToken } = await AuthService.registerUser(name, email, password);
  res.cookie('refreshToken', refreshToken, COOKIE_OPTS);
  logger.info(`[AUTH] ✅ Register success: "${email}" → user id=${user.id}`);
  sendSuccess(res, 'Account created successfully', { user, accessToken }, 201);
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body;
  logger.info(`[AUTH] Login attempt: "${email}"`);
  const result = await AuthService.loginUser(email, password);

  if (result.status === 'AUTHENTICATED') {
    res.cookie('refreshToken', result.refreshToken, COOKIE_OPTS);
    logger.info(`[AUTH] ✅ Login success: "${email}" role=${result.user.role}`);
    sendSuccess(res, 'Logged in successfully', result);
  } else {
    logger.info(`[AUTH] ⚠️  Email verification required for: "${email}"`);
    sendSuccess(res, 'Email verification required', result, 200);
  }
});

export const refreshToken = asyncHandler(async (req: Request, res: Response) => {
  const token = req.cookies?.refreshToken;
  if (!token) {
    logger.warn('[AUTH] Token refresh failed — no refresh token in cookie');
    sendError(res, 'No refresh token', 401);
    return;
  }
  logger.info('[AUTH] Token refresh requested');
  const tokens = await AuthService.refreshAccessToken(token);
  res.cookie('refreshToken', tokens.refreshToken, COOKIE_OPTS);
  logger.info('[AUTH] ✅ Access token refreshed');
  sendSuccess(res, 'Token refreshed', { accessToken: tokens.accessToken });
});

export const logout = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const token = req.cookies?.refreshToken;
  logger.info(`[AUTH] Logout: "${req.user?.email ?? 'unknown'}"`);
  if (req.user && token) await AuthService.logoutUser(req.user.id, token);
  res.clearCookie('refreshToken');
  logger.info(`[AUTH] ✅ Logged out: "${req.user?.email ?? 'unknown'}"`);
  sendSuccess(res, 'Logged out successfully');
});

export const getMe = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  logger.debug(`[AUTH] GetMe: "${req.user?.email}" (role=${req.user?.role})`);
  sendSuccess(res, 'User fetched', req.user);
});

export const resendLoginOtp = asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body;
  logger.info(`[AUTH] Resend login OTP requested for: "${email}"`);
  const expiresInSeconds = await AuthService.resendLoginOtp(email.toLowerCase());
  logger.info(`[AUTH] ✅ Login OTP resent to "${email}" (expires in ${expiresInSeconds}s)`);
  sendSuccess(res, 'Verification code sent', { email, verificationExpiresInSeconds: expiresInSeconds });
});
