import { Request, Response } from 'express';
import { body } from 'express-validator';
import * as https from 'https';
import crypto from 'crypto';
import * as AuthService from '../services/auth.service';
import { sendSuccess, sendError } from '../utils/response';
import { asyncHandler } from '../middleware/errorHandler';
import { AuthenticatedRequest } from '../types';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { REFRESH_COOKIE, REFRESH_COOKIE_OPTS, VERIFY_TICKET_COOKIE_OPTS, CLEAR_COOKIE_OPTS } from '../utils/auth-cookies';

function httpsPost(url: string, body: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        family: 4,
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    } catch (syncErr: unknown) {
      reject(syncErr);
    }
  });
}

function httpsGet(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      family: 4,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Validators ────────────────────────────────────────
// normalizeEmail() is deliberately NOT used on any of these.
// Its defaults strip dots and "+tags" out of Gmail addresses, so
// "ali.khan@gmail.com" became "alikhan@gmail.com" before the lookup — while
// signup (which goes through GraphQL, not these validators) stored the address
// exactly as typed. The two disagreed, and any account with a dot in its Gmail
// address could never be found at login.
// RFC 5321 2.4: the local part is to be interpreted only by the destination
// host, so an application should not rewrite it. Addresses are stored and
// looked up as typed; the service layer lowercases them, which is safe because
// providers treat addresses case-insensitively.
export const loginValidators = [
  body('email').isEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password is required'),
];

export const resendLoginOtpValidators = [
  body('email').isEmail().withMessage('Valid email required'),
];

// ── Controllers ───────────────────────────────────────
export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body;
  logger.info(`[AUTH] Login attempt: "${email}"`);
  const result = await AuthService.loginUser(email, password);

  if (result.status === 'AUTHENTICATED') {
    res.cookie(REFRESH_COOKIE, result.refreshToken, REFRESH_COOKIE_OPTS);
    logger.info(`[AUTH] ✅ Login success: "${email}" role=${result.user.role}`);
    sendSuccess(res, 'Logged in successfully', result);
  } else {
    // The ticket goes in an httpOnly cookie, never in the body.
    const { verificationTicket, ...body } = result;
    res.cookie(AuthService.VERIFY_TICKET_COOKIE, verificationTicket, VERIFY_TICKET_COOKIE_OPTS);
    logger.info(`[AUTH] ⚠️  Email verification required for: "${email}"`);
    sendSuccess(res, 'Email verification required', body, 200);
  }
});

export const refreshToken = asyncHandler(async (req: Request, res: Response) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) {
    logger.warn('[AUTH] Token refresh failed — no refresh token in cookie');
    sendError(res, 'No refresh token', 401);
    return;
  }
  logger.info('[AUTH] Token refresh requested');
  const tokens = await AuthService.refreshAccessToken(token);
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, REFRESH_COOKIE_OPTS);
  logger.info('[AUTH] ✅ Access token refreshed');
  sendSuccess(res, 'Token refreshed', { accessToken: tokens.accessToken });
});

// No `protect`: the refresh cookie is the credential here, so logout still ends
// the server-side session when the 15-minute access token has already expired.
export const logout = asyncHandler(async (req: Request, res: Response) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  const userId = token ? await AuthService.logoutUser(token) : null;
  res.clearCookie(REFRESH_COOKIE, CLEAR_COOKIE_OPTS);
  logger.info(`[AUTH] ✅ Logged out${userId ? `: user ${userId}` : ' (no live session)'}`);
  sendSuccess(res, 'Logged out successfully');
});

// Ends every session of the cookie's owner, on every device.
export const logoutAll = asyncHandler(async (req: Request, res: Response) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  const userId = token ? await AuthService.logoutAllSessions(token) : null;
  res.clearCookie(REFRESH_COOKIE, CLEAR_COOKIE_OPTS);
  logger.info(`[AUTH] ✅ Logged out everywhere${userId ? `: user ${userId}` : ' (no live session)'}`);
  sendSuccess(res, 'Logged out of all devices');
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
  const expiresInSeconds = await AuthService.resendLoginOtp(email.toLowerCase(), req.cookies?.[AuthService.VERIFY_TICKET_COOKIE]);
  logger.info(`[AUTH] ✅ Login OTP resent to "${email}" (expires in ${expiresInSeconds}s)`);
  sendSuccess(res, 'Verification code sent', { email, verificationExpiresInSeconds: expiresInSeconds });
});

// ── Google OAuth ──────────────────────────────────────
// Login-CSRF guard: a random state nonce goes to Google and into a short-lived
// httpOnly cookie; the callback only proceeds when the two match, so nobody can
// complete a sign-in in your browser with an authorization code of theirs.
// SameSite=Lax (not Strict) because the callback is a top-level navigation
// coming back from accounts.google.com, which a Strict cookie would not ride.
const OAUTH_STATE_COOKIE = 'oauth_state';
const OAUTH_STATE_COOKIE_OPTS = {
  httpOnly: true,
  secure:   env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path:     '/api/v1/auth/google',
};

const statesMatch = (a: string | undefined, b: string | undefined): boolean => {
  if (!a || !b) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export const googleRedirect = (_req: Request, res: Response): void => {
  const { CLIENT_ID, CALLBACK_URL } = env.GOOGLE;
  if (!CLIENT_ID) {
    res.status(503).send('Google OAuth is not configured on this server.');
    return;
  }
  const state = crypto.randomBytes(32).toString('base64url');
  res.cookie(OAUTH_STATE_COOKIE, state, { ...OAUTH_STATE_COOKIE_OPTS, maxAge: 10 * 60 * 1000 });
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  CALLBACK_URL,
    response_type: 'code',
    scope:         'openid email profile',
    access_type:   'offline',
    prompt:        'select_account',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
};

export const googleCallback = asyncHandler(async (req: Request, res: Response) => {
  const { code, state } = req.query as { code?: string; state?: string };
  const { CLIENT_ID, CLIENT_SECRET, CALLBACK_URL } = env.GOOGLE;

  // One-shot: the nonce is cleared whatever happens next.
  const expectedState = req.cookies?.[OAUTH_STATE_COOKIE] as string | undefined;
  res.clearCookie(OAUTH_STATE_COOKIE, OAUTH_STATE_COOKIE_OPTS);
  if (!statesMatch(state, expectedState)) {
    logger.warn('[AUTH] Google OAuth callback rejected: state missing or does not match');
    res.redirect(`${env.FRONTEND_URL}/login?error=oauth_failed`);
    return;
  }

  if (!code || !CLIENT_ID || !CLIENT_SECRET) {
    logger.warn('[AUTH] Google OAuth callback missing code or config');
    res.redirect(`${env.FRONTEND_URL}/login?error=oauth_failed`);
    return;
  }

  // Exchange authorization code for tokens
  let tokenResult: { status: number; body: string };
  try {
    const tokenBody = new URLSearchParams({
      code,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri:  CALLBACK_URL,
      grant_type:    'authorization_code',
    }).toString();
    tokenResult = await httpsPost(
      'https://oauth2.googleapis.com/token',
      tokenBody,
      { 'Content-Type': 'application/x-www-form-urlencoded' },
    );
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    logger.error(`[AUTH] Google token exchange network error: ${e?.code ?? e?.message ?? String(err)}`);
    res.redirect(`${env.FRONTEND_URL}/login?error=oauth_failed`);
    return;
  }

  if (tokenResult.status < 200 || tokenResult.status >= 300) {
    logger.error(`[AUTH] Google token exchange failed: ${tokenResult.status} — ${tokenResult.body.slice(0, 200)}`);
    res.redirect(`${env.FRONTEND_URL}/login?error=oauth_failed`);
    return;
  }

  const { access_token } = JSON.parse(tokenResult.body) as { access_token?: string };

  // Get Google user profile
  let profileResult: { status: number; body: string };
  try {
    profileResult = await httpsGet(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      { Authorization: `Bearer ${access_token}` },
    );
  } catch (err: unknown) {
    logger.error(`[AUTH] Google userinfo network error: ${(err as Error)?.message ?? String(err)}`);
    res.redirect(`${env.FRONTEND_URL}/login?error=oauth_failed`);
    return;
  }

  if (profileResult.status < 200 || profileResult.status >= 300) {
    logger.error(`[AUTH] Google userinfo fetch failed: ${profileResult.status}`);
    res.redirect(`${env.FRONTEND_URL}/login?error=oauth_failed`);
    return;
  }

  const googleUser = JSON.parse(profileResult.body) as {
    id: string; name: string; email: string; picture?: string; verified_email?: boolean;
  };

  // Only an address Google itself has verified is evidence of owning it.
  if (googleUser.verified_email !== true || !googleUser.email) {
    logger.warn(`[AUTH] Google OAuth rejected: email not verified by Google ("${googleUser.email}")`);
    res.redirect(`${env.FRONTEND_URL}/login?error=oauth_unverified_email`);
    return;
  }

  logger.info(`[AUTH] Google OAuth: profile for "${googleUser.email}"`);

  const result = await AuthService.googleOAuthUser({
    googleId:  googleUser.id,
    name:      googleUser.name,
    email:     googleUser.email,
    avatarUrl: googleUser.picture,
  });
  if (result.status === 'ACCOUNT_EXISTS') {
    res.redirect(`${env.FRONTEND_URL}/login?error=oauth_account_exists`);
    return;
  }

  // Only the httpOnly refresh cookie leaves here. The access token is never put
  // in the URL (where history, logs and Referer would keep it): the callback page
  // obtains one through the normal silent refresh.
  res.cookie(REFRESH_COOKIE, result.refreshToken, REFRESH_COOKIE_OPTS);
  logger.info(`[AUTH] ✅ Google OAuth success: "${googleUser.email}"`);
  res.redirect(`${env.FRONTEND_URL}/auth/google/callback`);
});
