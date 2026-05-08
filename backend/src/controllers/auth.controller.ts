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

export const updateMe = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { name, currentPassword, newPassword, avatarUrl } = req.body;
  logger.info(`[AUTH] UpdateMe: "${req.user?.email}"`);
  const updated = await AuthService.updateProfile(req.user!.id, { name, currentPassword, newPassword, avatarUrl });
  sendSuccess(res, 'Profile updated', updated);
});

export const resendLoginOtp = asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body;
  logger.info(`[AUTH] Resend login OTP requested for: "${email}"`);
  const expiresInSeconds = await AuthService.resendLoginOtp(email.toLowerCase());
  logger.info(`[AUTH] ✅ Login OTP resent to "${email}" (expires in ${expiresInSeconds}s)`);
  sendSuccess(res, 'Verification code sent', { email, verificationExpiresInSeconds: expiresInSeconds });
});

// ── Google OAuth ──────────────────────────────────────
export const googleRedirect = (_req: Request, res: Response): void => {
  const { CLIENT_ID, CALLBACK_URL } = env.GOOGLE;
  if (!CLIENT_ID) {
    res.status(503).send('Google OAuth is not configured on this server.');
    return;
  }
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  CALLBACK_URL,
    response_type: 'code',
    scope:         'openid email profile',
    access_type:   'offline',
    prompt:        'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
};

export const googleCallback = asyncHandler(async (req: Request, res: Response) => {
  const { code } = req.query as { code?: string };
  const { CLIENT_ID, CLIENT_SECRET, CALLBACK_URL } = env.GOOGLE;

  if (!code || !CLIENT_ID || !CLIENT_SECRET) {
    logger.warn('[AUTH] Google OAuth callback missing code or config');
    res.redirect(`${env.FRONTEND_URL}/login?error=oauth_failed`);
    return;
  }

  // Exchange authorization code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      code,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri:  CALLBACK_URL,
      grant_type:    'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    logger.error(`[AUTH] Google token exchange failed: ${tokenRes.status}`);
    res.redirect(`${env.FRONTEND_URL}/login?error=oauth_failed`);
    return;
  }

  const { access_token } = await tokenRes.json() as { access_token?: string };

  // Get Google user profile
  const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${access_token}` },
  });

  if (!profileRes.ok) {
    logger.error(`[AUTH] Google userinfo fetch failed: ${profileRes.status}`);
    res.redirect(`${env.FRONTEND_URL}/login?error=oauth_failed`);
    return;
  }

  const googleUser = await profileRes.json() as {
    id: string; name: string; email: string; picture?: string;
  };

  logger.info(`[AUTH] Google OAuth: profile for "${googleUser.email}"`);

  const { accessToken, refreshToken } = await AuthService.googleOAuthUser({
    googleId:  googleUser.id,
    name:      googleUser.name,
    email:     googleUser.email,
    avatarUrl: googleUser.picture,
  });

  res.cookie('refreshToken', refreshToken, COOKIE_OPTS);
  logger.info(`[AUTH] ✅ Google OAuth success: "${googleUser.email}"`);
  res.redirect(`${env.FRONTEND_URL}/auth/google/callback?token=${accessToken}`);
});
