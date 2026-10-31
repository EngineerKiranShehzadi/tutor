import type { CookieOptions } from 'express';
import { env } from '../config/env';

// Cookie attributes shared by the REST auth controller and the GraphQL auth
// resolver, so the two can never set (or fail to clear) a cookie differently.
// clearCookie only matches a cookie set with the same attributes, minus maxAge.

const base = {
  httpOnly: true,
  secure:   env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
};

export const REFRESH_COOKIE = 'refreshToken';
export const REFRESH_COOKIE_OPTS: CookieOptions = { ...base, maxAge: 7 * 24 * 60 * 60 * 1000 };

// Ties an email-verification code to the browser that asked for it
// (see VERIFY_TICKET_COOKIE in auth.service.ts). Outlives the 5-minute code so a
// resend still works a while later.
export const VERIFY_TICKET_COOKIE_OPTS: CookieOptions = { ...base, maxAge: 30 * 60 * 1000 };

export const CLEAR_COOKIE_OPTS: CookieOptions = base;
