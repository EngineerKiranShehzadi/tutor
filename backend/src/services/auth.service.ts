import { query } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { hashPassword, comparePassword, generateResetToken, hashToken } from '../utils/password';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { sendPasswordResetEmail } from './email.service';
import { env } from '../config/env';
import { User } from '../types';

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
export const loginUser = async (email: string, password: string) => {
  const { rows } = await query<User>(
    'SELECT * FROM users WHERE email = $1',
    [email.toLowerCase()]
  );
  const user = rows[0];
  if (!user) throw new AppError('Invalid email or password', 401);

  const valid = await comparePassword(password, user.password_hash);
  if (!valid) throw new AppError('Invalid email or password', 401);

  const accessToken  = generateAccessToken(user.id);
  const refreshToken = generateRefreshToken(user.id);
  await storeRefreshToken(user.id, refreshToken);

  const { password_hash: _, reset_token_hash: __, ...safeUser } = user;
  return { user: safeUser, accessToken, refreshToken };
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

// ── FORGOT PASSWORD ───────────────────────────────────
export const forgotPassword = async (email: string) => {
  const { rows } = await query<User>('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  const user = rows[0];

  // Always respond success to prevent email enumeration attacks
  if (!user) return;

  const resetToken = generateResetToken();
  const tokenHash  = hashToken(resetToken);
  const expires    = new Date(Date.now() + env.RESET_TOKEN_EXPIRES_MS);

  await query(
    'UPDATE users SET reset_token_hash = $1, reset_token_expires = $2 WHERE id = $3',
    [tokenHash, expires, user.id]
  );

  await sendPasswordResetEmail(user.email, user.name, resetToken);
};

// ── RESET PASSWORD ────────────────────────────────────
export const resetPassword = async (token: string, newPassword: string) => {
  const tokenHash = hashToken(token);

  const { rows } = await query<User>(
    `SELECT * FROM users
     WHERE reset_token_hash = $1 AND reset_token_expires > NOW()`,
    [tokenHash]
  );
  if (!rows[0]) throw new AppError('Reset link is invalid or has expired', 400);

  const password_hash = await hashPassword(newPassword);
  await query(
    `UPDATE users
     SET password_hash = $1, reset_token_hash = NULL, reset_token_expires = NULL
     WHERE id = $2`,
    [password_hash, rows[0].id]
  );

  // Invalidate all refresh tokens for this user
  await query('DELETE FROM refresh_tokens WHERE user_id = $1', [rows[0].id]);
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
