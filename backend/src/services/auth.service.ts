import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import pool, { query } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { hashPassword, comparePassword, hashToken } from '../utils/password';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { sendPasswordResetOtp, sendSignupVerificationOtp } from './email.service';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { User, PasswordResetToken, EmailVerificationToken } from '../types';

// ── REGISTER ──────────────────────────────────────────
export const registerUser = async (name: string, email: string, password: string) => {
  const existing = await query<User>('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows[0]) throw new AppError('Email already in use', 409);

  const password_hash = await hashPassword(password);
  const { rows } = await query<User>(
    `INSERT INTO users (name, email, password_hash)
     VALUES ($1, $2, $3)
     RETURNING id, name, email, avatar_url, created_at`,
    [name.trim(), email.toLowerCase(), password_hash]
  );

  const user = rows[0];
  const accessToken  = generateAccessToken(user.id);
  const refreshToken = generateRefreshToken(user.id);
  await storeRefreshToken(user.id, refreshToken);

  return { user, accessToken, refreshToken };
};

// ── LOGIN ─────────────────────────────────────────────
type LoginResult =
  | { status: 'AUTHENTICATED'; user: Omit<User, 'password_hash'>; accessToken: string; refreshToken: string }
  | { status: 'EMAIL_VERIFICATION_REQUIRED'; email: string; verificationExpiresInSeconds: number };

export const loginUser = async (email: string, password: string): Promise<LoginResult> => {
  const { rows } = await query<User>(
    'SELECT * FROM users WHERE email = $1',
    [email.toLowerCase()]
  );
  const user = rows[0];
  if (!user) throw new AppError('Invalid email or password', 401);

  const valid = await comparePassword(password, user.password_hash);
  if (!valid) throw new AppError('Invalid email or password', 401);

  if (!user.is_verified) {
    // Check for existing valid OTP to avoid duplicate emails
    const { rows: existingTokens } = await query<EmailVerificationToken>(
      `SELECT * FROM email_verification_tokens
       WHERE user_id = $1 AND used = FALSE
       ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    const existingToken = existingTokens[0];

    if (existingToken && new Date(existingToken.expires_at) > new Date()) {
      // Valid OTP exists, reuse it and return remaining time
      const expiresInSeconds = Math.ceil((new Date(existingToken.expires_at).getTime() - Date.now()) / 1000);
      return {
        status: 'EMAIL_VERIFICATION_REQUIRED',
        email: user.email,
        verificationExpiresInSeconds: Math.max(0, expiresInSeconds)
      };
    }

    // No valid OTP, issue a fresh one
    const otp = await issueEmailVerificationOtp(user.id);

    if (env.NODE_ENV !== 'production') {
      logger.info(`[DEV] Login Verification OTP for ${user.email}: ${otp}`);
    }

    if (env.EMAIL.USER && env.EMAIL.PASSWORD) {
      try {
        await sendSignupVerificationOtp(user.email, user.name, otp);
      } catch (emailErr) {
        logger.warn('Failed to send verification OTP email', emailErr);
        if (env.NODE_ENV === 'production') {
          throw new AppError('Failed to send verification email. Please try again.', 500);
        }
      }
    }

    return {
      status: 'EMAIL_VERIFICATION_REQUIRED',
      email: user.email,
      verificationExpiresInSeconds: 60
    };
  }

  const accessToken  = generateAccessToken(user.id);
  const refreshToken = generateRefreshToken(user.id);
  await storeRefreshToken(user.id, refreshToken);

  const { password_hash: _, ...safeUser } = user;
  return { status: 'AUTHENTICATED', user: safeUser, accessToken, refreshToken };
};

// ── REFRESH TOKEN ─────────────────────────────────────
export const refreshAccessToken = async (refreshToken: string) => {
  const payload = verifyRefreshToken(refreshToken);
  const tokenHash = hashToken(refreshToken);

  const { rows } = await query(
    `SELECT * FROM refresh_tokens
     WHERE user_id = $1 AND token_hash = $2 AND expires_at > NOW()`,
    [payload.userId, tokenHash]
  );
  if (!rows[0]) throw new AppError('Invalid or expired refresh token', 401);

  const newAccessToken  = generateAccessToken(payload.userId);
  const newRefreshToken = generateRefreshToken(payload.userId);

  await query('DELETE FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);
  await storeRefreshToken(payload.userId, newRefreshToken);

  return { accessToken: newAccessToken, refreshToken: newRefreshToken };
};

// ── LOGOUT ────────────────────────────────────────────
export const logoutUser = async (userId: string, refreshToken: string) => {
  const tokenHash = hashToken(refreshToken);
  await query(
    'DELETE FROM refresh_tokens WHERE user_id = $1 AND token_hash = $2',
    [userId, tokenHash]
  );
};

// ── OTP: INTERNAL ─────────────────────────────────────
// Shared by requestPasswordReset and resendPasswordResetOtp
const issuePasswordResetOtp = async (email: string): Promise<void> => {
  const { rows } = await query<User>(
    'SELECT * FROM users WHERE email = $1',
    [email.toLowerCase()]
  );
  const user = rows[0];
  if (!user) throw new AppError('No account found with that email address', 400);

  // 5-digit OTP via cryptographically secure random
  const otp = crypto.randomInt(10000, 100000).toString();
  const codeHash = await bcrypt.hash(otp, 12);
  const expiresAt = new Date(Date.now() + 60 * 1000); // 60 seconds

  // Invalidate all previous unused tokens for this user
  await query(
    'UPDATE password_reset_tokens SET used = TRUE WHERE user_id = $1 AND used = FALSE',
    [user.id]
  );

  // Create new token record
  await query(
    'INSERT INTO password_reset_tokens (user_id, code_hash, expires_at) VALUES ($1, $2, $3)',
    [user.id, codeHash, expiresAt]
  );

  // Dev fallback: always log OTP in non-production
  if (env.NODE_ENV !== 'production') {
    logger.info(`[DEV] Password Reset OTP for ${user.email}: ${otp}`);
  }

  // Send email (skip gracefully in dev if SMTP not configured)
  if (env.EMAIL.USER && env.EMAIL.PASSWORD) {
    try {
      await sendPasswordResetOtp(user.email, user.name, otp);
    } catch (emailErr) {
      logger.warn('Failed to send OTP email', emailErr);
      if (env.NODE_ENV === 'production') {
        throw new AppError('Failed to send OTP email. Please try again.', 500);
      }
    }
  }
};

// ── OTP: REQUEST ──────────────────────────────────────
export const requestPasswordReset = async (email: string): Promise<void> => {
  await issuePasswordResetOtp(email);
};

// ── OTP: RESEND ───────────────────────────────────────
export const resendPasswordResetOtp = async (email: string): Promise<void> => {
  await issuePasswordResetOtp(email);
};

// ── OTP: VERIFY ───────────────────────────────────────
export const verifyOtp = async (email: string, code: string): Promise<void> => {
  const { rows: userRows } = await query<User>(
    'SELECT * FROM users WHERE email = $1',
    [email.toLowerCase()]
  );
  const user = userRows[0];
  if (!user) throw new AppError('No account found with that email address', 400);

  const { rows: tokenRows } = await query<PasswordResetToken>(
    `SELECT * FROM password_reset_tokens
     WHERE user_id = $1 AND used = FALSE
     ORDER BY created_at DESC LIMIT 1`,
    [user.id]
  );
  const token = tokenRows[0];
  if (!token) throw new AppError('No pending OTP found. Please request a new one.', 400);

  if (new Date(token.expires_at) < new Date()) {
    throw new AppError('Expired OTP. Please request a new one.', 400);
  }

  const valid = await bcrypt.compare(code, token.code_hash);
  if (!valid) throw new AppError('Invalid OTP. Please check and try again.', 400);

  // Mark verified — token is NOT consumed yet, only consumed after password reset
  await query(
    'UPDATE password_reset_tokens SET verified = TRUE WHERE id = $1',
    [token.id]
  );
};

// ── OTP: RESET PASSWORD ───────────────────────────────
export const resetPasswordWithOtp = async (
  email: string,
  newPassword: string,
  confirmPassword: string
): Promise<void> => {
  if (newPassword !== confirmPassword) {
    throw new AppError('Passwords do not match', 400);
  }

  const { rows: userRows } = await query<User>(
    'SELECT * FROM users WHERE email = $1',
    [email.toLowerCase()]
  );
  const user = userRows[0];
  if (!user) throw new AppError('No account found with that email address', 400);

  // Require a token that is verified but not yet used
  const { rows: tokenRows } = await query<PasswordResetToken>(
    `SELECT * FROM password_reset_tokens
     WHERE user_id = $1 AND used = FALSE AND verified = TRUE
     ORDER BY created_at DESC LIMIT 1`,
    [user.id]
  );
  const token = tokenRows[0];
  if (!token) throw new AppError('OTP not verified. Please complete verification first.', 400);

  const password_hash = await hashPassword(newPassword);

  // Atomic transaction: update password + consume token + invalidate all sessions
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [password_hash, user.id]
    );
    await client.query(
      'UPDATE password_reset_tokens SET used = TRUE WHERE id = $1',
      [token.id]
    );
    await client.query(
      'DELETE FROM refresh_tokens WHERE user_id = $1',
      [user.id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ── SIGNUP: INTERNAL OTP HELPER ───────────────────────
const issueEmailVerificationOtp = async (userId: string): Promise<string> => {
  const otp = crypto.randomInt(10000, 100000).toString();
  const codeHash = await bcrypt.hash(otp, 12);
  const expiresAt = new Date(Date.now() + 60_000);

  // Invalidate old unused tokens
  await query(
    'UPDATE email_verification_tokens SET used = TRUE WHERE user_id = $1 AND used = FALSE',
    [userId]
  );

  // Store new token
  await query(
    'INSERT INTO email_verification_tokens (user_id, code_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, codeHash, expiresAt]
  );

  return otp;
};

// ── SIGNUP: INITIATE ───────────────────────────────────
export const signupUser = async (
  name: string,
  email: string,
  password: string
): Promise<{ email: string; message: string }> => {
  const existing = await query<User>('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing.rows[0]) throw new AppError('Email already in use', 409);

  const password_hash = await hashPassword(password);
  const { rows } = await query<User>(
    `INSERT INTO users (name, email, password_hash, is_verified)
     VALUES ($1, $2, $3, FALSE)
     RETURNING id, name, email, avatar_url, created_at`,
    [name.trim(), email.toLowerCase(), password_hash]
  );
  const user = rows[0];

  const otp = await issueEmailVerificationOtp(user.id);

  if (env.NODE_ENV !== 'production') {
    logger.info(`[DEV] Signup OTP for ${user.email}: ${otp}`);
  }

  let message = 'A verification code has been sent to your email address.';
  if (env.EMAIL.USER && env.EMAIL.PASSWORD) {
    try {
      await sendSignupVerificationOtp(user.email, user.name, otp);
    } catch {
      message = 'Account created. The verification email failed to send — use "Resend code" to try again.';
    }
  }

  return { email: user.email, message };
};

// ── SIGNUP: RESEND OTP ────────────────────────────────
export const resendSignupOtp = async (email: string): Promise<void> => {
  const { rows } = await query<User>('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  const user = rows[0];
  if (!user) throw new AppError('Email not found', 404);
  if (user.is_verified) throw new AppError('Email is already verified', 400);

  const otp = await issueEmailVerificationOtp(user.id);

  if (env.NODE_ENV !== 'production') {
    logger.info(`[DEV] Signup Resend OTP for ${user.email}: ${otp}`);
  }

  if (env.EMAIL.USER && env.EMAIL.PASSWORD) {
    await sendSignupVerificationOtp(user.email, user.name, otp);
  }
};

// ── LOGIN: RESEND EMAIL VERIFICATION OTP ──────────────
export const resendLoginOtp = async (email: string): Promise<number> => {
  const { rows } = await query<User>('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  const user = rows[0];
  if (!user) throw new AppError('Email not found', 404);
  if (user.is_verified) throw new AppError('Email is already verified', 400);

  // Check for existing valid OTP
  const { rows: existingTokens } = await query<EmailVerificationToken>(
    `SELECT * FROM email_verification_tokens
     WHERE user_id = $1 AND used = FALSE
     ORDER BY created_at DESC LIMIT 1`,
    [user.id]
  );
  const existingToken = existingTokens[0];

  if (existingToken && new Date(existingToken.expires_at) > new Date()) {
    // Valid OTP exists, return remaining time without sending new email
    const expiresInSeconds = Math.ceil((new Date(existingToken.expires_at).getTime() - Date.now()) / 1000);
    return Math.max(0, expiresInSeconds);
  }

  // Issue fresh OTP
  const otp = await issueEmailVerificationOtp(user.id);

  if (env.NODE_ENV !== 'production') {
    logger.info(`[DEV] Login Resend OTP for ${user.email}: ${otp}`);
  }

  if (env.EMAIL.USER && env.EMAIL.PASSWORD) {
    try {
      await sendSignupVerificationOtp(user.email, user.name, otp);
    } catch (emailErr) {
      logger.warn('Failed to send verification OTP email', emailErr);
      if (env.NODE_ENV === 'production') {
        throw new AppError('Failed to send verification email. Please try again.', 500);
      }
    }
  }

  return 60;
};

// ── SIGNUP: VERIFY OTP ────────────────────────────────
export const verifySignupOtp = async (
  email: string,
  code: string
): Promise<{ user: Omit<User, 'password_hash'>; accessToken: string; refreshToken: string }> => {
  const { rows: userRows } = await query<User>('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  const user = userRows[0];
  if (!user) throw new AppError('Invalid OTP', 400);

  const { rows: tokenRows } = await query<EmailVerificationToken>(
    `SELECT * FROM email_verification_tokens
     WHERE user_id = $1 AND used = FALSE
     ORDER BY created_at DESC LIMIT 1`,
    [user.id]
  );
  const token = tokenRows[0];
  if (!token) throw new AppError('Invalid OTP', 400);

  if (new Date(token.expires_at) < new Date()) {
    await query('UPDATE email_verification_tokens SET used = TRUE WHERE id = $1', [token.id]);
    throw new AppError('Expired OTP. Please request a new one.', 400);
  }

  const valid = await bcrypt.compare(code, token.code_hash);
  if (!valid) throw new AppError('Invalid OTP', 400);

  // Atomic: mark user verified + consume token
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET is_verified = TRUE WHERE id = $1', [user.id]);
    await client.query('UPDATE email_verification_tokens SET used = TRUE WHERE id = $1', [token.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { rows: freshRows } = await query<User>('SELECT * FROM users WHERE id = $1', [user.id]);
  const freshUser = freshRows[0];

  const accessToken  = generateAccessToken(freshUser.id);
  const refreshToken = generateRefreshToken(freshUser.id);
  await storeRefreshToken(freshUser.id, refreshToken);

  const { password_hash: _, ...safeUser } = freshUser;
  return { user: safeUser, accessToken, refreshToken };
};

// ── HELPER ────────────────────────────────────────────
const storeRefreshToken = async (userId: string, token: string) => {
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  await query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, tokenHash, expiresAt]
  );
};
