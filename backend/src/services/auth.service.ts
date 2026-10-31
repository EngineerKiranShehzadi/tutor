import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type { PoolClient } from 'pg';
import pool, { query } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { hashPassword, comparePassword, hashToken } from '../utils/password';
import { validatePassword } from '../utils/password-policy';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { sendPasswordResetOtp, sendSignupVerificationOtp, sendAccountExistsNotice } from './email.service';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { User, PasswordResetToken, EmailVerificationToken } from '../types';

// The OTP now lives 5 minutes, but the client uses the number we return as the
// resend-button cooldown, so that stays 60 seconds.
const RESEND_COOLDOWN_SECONDS = 60;

// A real bcrypt hash (of a random value) at the configured cost, compared
// against when there is no account, so that path costs the same as a real one.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), env.BCRYPT_SALT_ROUNDS);

// Every incoming address is compared trimmed and lowercased against
// lower(email) — the expression migration 012's unique index is on, so the
// lookup can use it and a row stored with capitals (e.g. a hand-inserted
// admin) still matches. Migration 017 lowercases stored addresses.
const normEmail = (e: string): string => e.trim().toLowerCase();

// ── LOGIN ─────────────────────────────────────────────
type LoginResult =
  | { status: 'AUTHENTICATED'; user: Omit<User, 'password_hash'>; accessToken: string; refreshToken: string }
  | { status: 'EMAIL_VERIFICATION_REQUIRED'; email: string; verificationExpiresInSeconds: number; verificationTicket: string };

export const loginUser = async (email: string, password: string): Promise<LoginResult> => {
  logger.info(`[AUTH] loginUser: attempt for "${email}"`);
  const { rows } = await query<User>(
    'SELECT * FROM users WHERE lower(email) = $1',
    [normEmail(email)]
  );
  const user = rows[0];
  // Missing accounts and Google-only accounts still run one bcrypt compare and
  // get the same message as a wrong password, so neither the response nor its
  // timing tells a caller whether (or how) an address is registered.
  if (!user || !user.password_hash) {
    await comparePassword(password, DUMMY_PASSWORD_HASH);
    logger.warn(`[AUTH] loginUser: ${user ? 'Google-only account attempted password login' : 'no account found'} — "${email}"`);
    throw new AppError('Invalid email or password', 401);
  }

  const valid = await comparePassword(password, user.password_hash);
  if (!valid) {
    logger.warn(`[AUTH] loginUser: wrong password for "${email}"`);
    throw new AppError('Invalid email or password', 401);
  }

  if (!user.is_verified) {
    // Check for existing valid OTP to avoid duplicate emails
    const { rows: existingTokens } = await query<EmailVerificationToken>(
      `SELECT * FROM email_verification_tokens
       WHERE user_id = $1 AND used = FALSE
       ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    const existingToken = existingTokens[0];

    // The password was just proven, so this browser may verify the account:
    // hand it a new ticket (any earlier browser's ticket stops working).
    const verificationTicket = newVerificationTicket();

    if (existingToken && new Date(existingToken.expires_at) > new Date()) {
      // Valid OTP exists: reuse it (no duplicate email), bound to this browser
      await query('UPDATE email_verification_tokens SET ticket_hash = $2 WHERE id = $1', [existingToken.id, hashToken(verificationTicket)]);
      const expiresInSeconds = Math.ceil((new Date(existingToken.expires_at).getTime() - Date.now()) / 1000);
      return {
        status: 'EMAIL_VERIFICATION_REQUIRED',
        email: user.email,
        verificationExpiresInSeconds: Math.min(RESEND_COOLDOWN_SECONDS, Math.max(0, expiresInSeconds)),
        verificationTicket,
      };
    }

    // No valid OTP, issue a fresh one
    const otp = await issueEmailVerificationOtp(user.id, verificationTicket);

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
      verificationExpiresInSeconds: RESEND_COOLDOWN_SECONDS,
      verificationTicket,
    };
  }

  const accessToken  = generateAccessToken(user.id, user.role);
  const refreshToken = generateRefreshToken(user.id, user.role);
  await storeRefreshToken(user.id, refreshToken);

  const { password_hash: _, ...safeUser } = user;
  logger.info(`[AUTH] ✅ Login success: "${email}" role=${user.role}`);
  return { status: 'AUTHENTICATED', user: safeUser, accessToken, refreshToken };
};

// ── REFRESH TOKEN ─────────────────────────────────────
// Rotation with reuse detection. Every login starts a token FAMILY; each refresh
// marks the presented token rotated (kept, not deleted) and issues a successor in
// the same family. Presenting an already-rotated token means two parties hold
// the family — the user and whoever copied the token — so the whole family is
// revoked and both must log in again.
//
// A browser with two tabs can legitimately present the same token twice in a
// moment (both refresh at once); a replay inside ROTATION_GRACE_MS is refused
// without revoking anything (409, so the client retries with the new cookie).
const ROTATION_GRACE_MS = 10_000;

export const refreshAccessToken = async (refreshToken: string) => {
  logger.info('[AUTH] refreshAccessToken: verifying refresh token');
  let payload: ReturnType<typeof verifyRefreshToken>;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw new AppError('Invalid or expired refresh token', 401);
  }
  const tokenHash = hashToken(refreshToken);

  // One transaction with the row locked: concurrent refreshes of the same token
  // are serialized, so only one of them can rotate it.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string; user_id: string; family_id: string; rotated_at: Date | null; expires_at: Date }>(
      `SELECT id, user_id, family_id, rotated_at, expires_at FROM refresh_tokens
       WHERE token_hash = $1 FOR UPDATE`,
      [tokenHash]
    );
    const row = rows[0];
    if (!row || row.user_id !== payload.userId || new Date(row.expires_at) <= new Date()) {
      await client.query('COMMIT');
      logger.warn(`[AUTH] refreshAccessToken: invalid or expired token for user ${payload.userId}`);
      throw new AppError('Invalid or expired refresh token', 401);
    }

    if (row.rotated_at) {
      if (Date.now() - new Date(row.rotated_at).getTime() > ROTATION_GRACE_MS) {
        const revoked = await client.query('DELETE FROM refresh_tokens WHERE family_id = $1', [row.family_id]);
        await client.query('COMMIT');
        logger.warn(`[AUTH] refreshAccessToken: REUSE of a rotated refresh token for user ${row.user_id} — family ${row.family_id} revoked (${revoked.rowCount} rows)`);
        throw new AppError('Invalid or expired refresh token', 401);
      }
      await client.query('COMMIT');
      logger.warn(`[AUTH] refreshAccessToken: concurrent refresh of the same token for user ${row.user_id} — refused, not revoked`);
      // 409, not 401: the browser's cookie jar already holds the successor (set
      // by the request that won), so the client should simply retry once.
      throw new AppError('Refresh already in progress — retry', 409);
    }

    // The role comes from the database, never from the old token: a demotion or
    // promotion since that token was minted must take effect now.
    const { rows: userRows } = await client.query<{ role: User['role'] }>('SELECT role FROM users WHERE id = $1', [row.user_id]);
    if (!userRows[0]) {
      await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [row.user_id]);
      await client.query('COMMIT');
      throw new AppError('Invalid or expired refresh token', 401);
    }
    const role = userRows[0].role;

    const newAccessToken  = generateAccessToken(row.user_id, role);
    const newRefreshToken = generateRefreshToken(row.user_id, role);

    await client.query('UPDATE refresh_tokens SET rotated_at = NOW() WHERE id = $1', [row.id]);
    await insertRefreshToken(client, row.user_id, newRefreshToken, row.family_id);
    await client.query('COMMIT');

    logger.info(`[AUTH] ✅ Access token refreshed for user ${row.user_id} (role=${role})`);
    return { accessToken: newAccessToken, refreshToken: newRefreshToken };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};

// ── LOGOUT ────────────────────────────────────────────
// Authenticated by the refresh cookie itself, not the access token: an expired
// access token must not stop the server-side session from being ended. The
// whole family goes (its rotated rows too). Returns the owner's id, or null if
// the token matched nothing.
export const logoutUser = async (refreshToken: string): Promise<string | null> => {
  const { rows } = await query<{ user_id: string }>(
    `DELETE FROM refresh_tokens
     WHERE family_id IN (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)
     RETURNING user_id`,
    [hashToken(refreshToken)]
  );
  const userId = rows[0]?.user_id ?? null;
  logger.info(`[AUTH] ✅ logoutUser: ${userId ? `session revoked for user ${userId} (${rows.length} rows)` : 'token matched no session'}`);
  return userId;
};

// "Log out everywhere": every session of the user who owns this refresh token.
export const logoutAllSessions = async (refreshToken: string): Promise<string | null> => {
  const { rows } = await query<{ user_id: string }>(
    'SELECT user_id FROM refresh_tokens WHERE token_hash = $1',
    [hashToken(refreshToken)]
  );
  const userId = rows[0]?.user_id;
  if (!userId) return null;
  await revokeAllSessions(userId);
  return userId;
};

export const revokeAllSessions = async (userId: string): Promise<number> => {
  const { rowCount } = await query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
  logger.info(`[AUTH] ✅ All sessions revoked for user ${userId} (${rowCount ?? 0} rows)`);
  return rowCount ?? 0;
};

// A password change ends every OTHER session of the user: if the password was
// changed because it leaked, a stolen refresh-token family must die too (each
// rotation would otherwise renew it for 7 days, forever). The session that
// presents keepRefreshToken — the one making the change — stays signed in.
// Without it (or if it matches nothing) every session is revoked.
export const revokeOtherSessions = async (userId: string, keepRefreshToken?: string): Promise<number> => {
  if (!keepRefreshToken) return revokeAllSessions(userId);
  const { rowCount } = await query(
    `DELETE FROM refresh_tokens
     WHERE user_id = $1
       AND family_id IS DISTINCT FROM
           (SELECT family_id FROM refresh_tokens WHERE token_hash = $2 AND user_id = $1)`,
    [userId, hashToken(keepRefreshToken)]
  );
  logger.info(`[AUTH] ✅ Other sessions revoked for user ${userId} (${rowCount ?? 0} rows)`);
  return rowCount ?? 0;
};

// Expired rows (live or rotated) are useless; called on a timer from server.ts.
export const purgeExpiredRefreshTokens = async (): Promise<number> => {
  const { rowCount } = await query('DELETE FROM refresh_tokens WHERE expires_at <= NOW()');
  if (rowCount) logger.info(`[AUTH] purged ${rowCount} expired refresh tokens`);
  return rowCount ?? 0;
};

// ── OTP: GUESS LIMIT ──────────────────────────────────
// A 6-digit code has only a million values, so without a cap it can be
// brute-forced inside its lifetime. Each code gets OTP_MAX_ATTEMPTS guesses.
// The guess is RESERVED (counter incremented, atomically) BEFORE the slow bcrypt
// compare, so parallel requests cannot all pass a "still under the limit" check
// and exceed the cap together.
const OTP_MAX_ATTEMPTS = 5;
// One message for every way a code can fail (unknown email, no live code,
// expired, wrong, out of guesses). Distinct messages would tell a caller which
// addresses have a pending reset or signup.
const OTP_REJECTED = 'Invalid or expired code. Please check it, or request a new one.';

type OtpTable = 'password_reset_tokens' | 'email_verification_tokens';

// Returns which guess this is (1..OTP_MAX_ATTEMPTS), or null when the code has
// no guesses left or was already used.
const reserveOtpAttempt = async (table: OtpTable, tokenId: string): Promise<number | null> => {
  const { rows } = await query<{ attempts: number }>(
    `UPDATE ${table} SET attempts = attempts + 1
     WHERE id = $1 AND used = FALSE AND attempts < $2
     RETURNING attempts`,
    [tokenId, OTP_MAX_ATTEMPTS]
  );
  return rows[0]?.attempts ?? null;
};

// Throws the right error for a wrong code, burning the code on the last guess.
const rejectWrongOtp = async (table: OtpTable, tokenId: string, attemptNo: number): Promise<never> => {
  if (attemptNo >= OTP_MAX_ATTEMPTS) {
    await query(`UPDATE ${table} SET used = TRUE WHERE id = $1`, [tokenId]);
  }
  throw new AppError(OTP_REJECTED, 400);
};

// ── OTP: INTERNAL ─────────────────────────────────────
// Shared by requestPasswordReset and resendPasswordResetOtp
const issuePasswordResetOtp = async (email: string): Promise<void> => {
  const { rows } = await query<User>(
    'SELECT * FROM users WHERE lower(email) = $1',
    [normEmail(email)]
  );
  const user = rows[0];
  // 6-digit OTP via cryptographically secure random (NIST SP 800-63B: minimum 6 digits).
  // Generated and hashed (cost 12) before the existence check, so a missing
  // account does exactly the same slow work as a real one.
  const otp = crypto.randomInt(100000, 1000000).toString();
  const codeHash = await bcrypt.hash(otp, 12);

  if (!user) {
    // Same outward behaviour as a real account: report success, send nothing.
    // The real reason stays in the log.
    logger.warn(`[AUTH] password reset requested for unknown email "${email}" — no OTP sent`);
    return;
  }

  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes (NIST SP 800-63B: max 10 min)

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

  // Send email (skip gracefully in dev if SMTP not configured). Not awaited: an
  // SMTP round-trip only on this branch would make a registered address
  // answer measurably slower than an unknown one. A failed send is logged; the
  // user can use "Resend code".
  if (env.EMAIL.USER && env.EMAIL.PASSWORD) {
    void sendPasswordResetOtp(user.email, user.name, otp)
      .catch(emailErr => logger.warn(`[AUTH] password reset OTP email failed for user ${user.id}`, emailErr));
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
// Returns a single-use reset ticket for the caller's browser (the resolver puts
// it in the httpOnly reset_ticket cookie). Only its hash is stored, and only the
// holder of the ticket can then set the new password — knowing the email is
// not enough.
export const verifyOtp = async (email: string, code: string): Promise<string> => {
  logger.info(`[AUTH] verifyOtp: password reset OTP verification for "${email}"`);
  const { rows: userRows } = await query<User>(
    'SELECT * FROM users WHERE lower(email) = $1',
    [normEmail(email)]
  );
  const user = userRows[0];
  if (!user) {
    logger.warn(`[AUTH] verifyOtp: no user found for "${email}"`);
    throw new AppError(OTP_REJECTED, 400);
  }

  const { rows: tokenRows } = await query<PasswordResetToken>(
    `SELECT * FROM password_reset_tokens
     WHERE user_id = $1 AND used = FALSE AND verified = FALSE
     ORDER BY created_at DESC LIMIT 1`,
    [user.id]
  );
  const token = tokenRows[0];
  if (!token) throw new AppError(OTP_REJECTED, 400);

  if (new Date(token.expires_at) < new Date()) {
    await query('UPDATE password_reset_tokens SET used = TRUE WHERE id = $1', [token.id]);
    throw new AppError(OTP_REJECTED, 400);
  }

  const attemptNo = await reserveOtpAttempt('password_reset_tokens', token.id);
  if (attemptNo === null) throw new AppError(OTP_REJECTED, 400);

  const valid = await bcrypt.compare(code, token.code_hash);
  if (!valid) {
    logger.warn(`[AUTH] verifyOtp: invalid OTP code for "${email}" (attempt ${attemptNo}/${OTP_MAX_ATTEMPTS})`);
    await rejectWrongOtp('password_reset_tokens', token.id, attemptNo);
  }

  // Mark verified and bind it to this browser's ticket — the token is NOT
  // consumed yet, only after the password reset. Requiring this call to be the
  // one that flipped it means a concurrent or repeated verify can never report
  // success for a code it did not verify.
  const ticket = crypto.randomBytes(32).toString('base64url');
  const marked = await query(
    `UPDATE password_reset_tokens SET verified = TRUE, ticket_hash = $2
     WHERE id = $1 AND used = FALSE AND verified = FALSE`,
    [token.id, hashToken(ticket)]
  );
  if (marked.rowCount !== 1) throw new AppError(OTP_REJECTED, 400);
  logger.info(`[AUTH] ✅ Password reset OTP verified for "${email}"`);
  return ticket;
};

// ── OTP: RESET PASSWORD ───────────────────────────────
export const resetPasswordWithOtp = async (
  email: string,
  newPassword: string,
  confirmPassword: string,
  // The reset_ticket cookie verifyOtp issued to this browser.
  ticket: string | undefined
): Promise<void> => {
  logger.info(`[AUTH] resetPasswordWithOtp: password reset for "${email}"`);
  if (!ticket) {
    logger.warn(`[AUTH] resetPasswordWithOtp: no reset ticket presented for "${email}"`);
    throw new AppError(OTP_REJECTED, 400);
  }
  const ticketHash = hashToken(ticket);
  if (newPassword !== confirmPassword) {
    logger.warn(`[AUTH] resetPasswordWithOtp: passwords do not match for "${email}"`);
    throw new AppError('Passwords do not match', 400);
  }
  validatePassword(newPassword);

  const { rows: userRows } = await query<User>(
    'SELECT * FROM users WHERE lower(email) = $1',
    [normEmail(email)]
  );
  const user = userRows[0];
  if (!user) throw new AppError(OTP_REJECTED, 400);

  // Require a token that is verified, not yet used, still inside its
  // lifetime, and verified by THIS browser (ticket). verifyOtp does not consume
  // the token, so without the expires_at predicate a verified token stayed
  // usable for as long as the row existed.
  const { rows: tokenRows } = await query<PasswordResetToken>(
    `SELECT * FROM password_reset_tokens
     WHERE user_id = $1 AND used = FALSE AND verified = TRUE AND expires_at > NOW()
       AND ticket_hash = $2
     ORDER BY created_at DESC LIMIT 1`,
    [user.id, ticketHash]
  );
  const token = tokenRows[0];
  if (!token) throw new AppError(OTP_REJECTED, 400);

  const password_hash = await hashPassword(newPassword);

  // Atomic transaction: consume token + update password (and verify) + invalidate all sessions
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Consume first and require that this call is the one that flipped it, so
    // two concurrent resets cannot both spend the same verified token.
    const consumed = await client.query(
      'UPDATE password_reset_tokens SET used = TRUE WHERE id = $1 AND used = FALSE AND ticket_hash = $2',
      [token.id, ticketHash]
    );
    if (consumed.rowCount !== 1) {
      throw new AppError(OTP_REJECTED, 400);
    }
    // Completing a reset proves ownership of the inbox — exactly what email
    // verification proves — so it also verifies the account. This lets the
    // owner of an address squatted as an unverified account reclaim it in one
    // step; the squatter's password is replaced and any pending code dropped.
    await client.query(
      'UPDATE users SET password_hash = $1, is_verified = TRUE WHERE id = $2',
      [password_hash, user.id]
    );
    await client.query(
      'UPDATE email_verification_tokens SET used = TRUE WHERE user_id = $1 AND used = FALSE',
      [user.id]
    );
    await client.query(
      'DELETE FROM refresh_tokens WHERE user_id = $1',
      [user.id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`[AUTH] resetPasswordWithOtp: transaction failed for "${email}"`, err);
    throw err;
  } finally {
    client.release();
  }
  logger.info(`[AUTH] ✅ Password reset complete for "${email}" — all sessions invalidated`);
};

// ── SIGNUP: INTERNAL OTP HELPER ───────────────────────
// A verification code is only usable together with the ticket of the browser
// that asked for it (signup, or a login that proved the password). The ticket
// travels in the httpOnly verify_ticket cookie, set by the resolver/controller;
// only its hash is stored.
export const VERIFY_TICKET_COOKIE = 'verify_ticket';
const newVerificationTicket = (): string => crypto.randomBytes(32).toString('base64url');

// True when the newest code for this user was issued to the holder of `ticket`.
const ticketMatchesLatestCode = async (userId: string, ticket: string | undefined): Promise<boolean> => {
  if (!ticket) return false;
  const { rows } = await query<{ ticket_hash: string | null }>(
    `SELECT ticket_hash FROM email_verification_tokens
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return !!rows[0]?.ticket_hash && rows[0].ticket_hash === hashToken(ticket);
};

// A fresh 6-digit code and its bcrypt hash (cost 12, ~0.3 s). Split out so
// signupUser can pay for it before it knows whether the address is taken.
interface EmailOtp { otp: string; codeHash: string }
const newEmailOtp = async (): Promise<EmailOtp> => {
  const otp = crypto.randomInt(100000, 1000000).toString();
  return { otp, codeHash: await bcrypt.hash(otp, 12) };
};

const issueEmailVerificationOtp = async (userId: string, ticket: string, precomputed?: EmailOtp): Promise<string> => {
  const { otp, codeHash } = precomputed ?? await newEmailOtp();
  const expiresAt = new Date(Date.now() + 5 * 60_000); // 5 minutes (NIST SP 800-63B: max 10 min)

  // Invalidate old unused tokens
  await query(
    'UPDATE email_verification_tokens SET used = TRUE WHERE user_id = $1 AND used = FALSE',
    [userId]
  );

  // Store new token
  await query(
    'INSERT INTO email_verification_tokens (user_id, code_hash, expires_at, ticket_hash) VALUES ($1, $2, $3, $4)',
    [userId, codeHash, expiresAt, hashToken(ticket)]
  );

  return otp;
};

// ── SIGNUP: INPUT VALIDATION ───────────────────────────
// Signup reaches the server through GraphQL only, so these checks are the
// only server-side gate: a request sent straight to /graphql (bypassing the
// form) could otherwise create an account with any password at all.
//
// These rules deliberately mirror the browser rules in
// frontend/src/app/(auth)/signup/page.tsx, so a normal user sees no change.
// The length caps also match the users table (name VARCHAR(100),
// email VARCHAR(255)), turning what would be a raw database error into a
// clear message. The password rules live in utils/password-policy.ts and are
// shared with every other path that sets a password.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const validateSignupInput = (name: string, email: string, password: string): void => {
  const trimmedName = (name ?? '').trim();
  if (trimmedName.length < 2)   throw new AppError('Name must be at least 2 characters', 400);
  if (trimmedName.length > 100) throw new AppError('Name must be 100 characters or fewer', 400);

  const trimmedEmail = (email ?? '').trim();
  if (!EMAIL_PATTERN.test(trimmedEmail)) throw new AppError('Enter a valid email address', 400);
  if (trimmedEmail.length > 255)         throw new AppError('Email must be 255 characters or fewer', 400);

  validatePassword(password);
};

// ── SIGNUP: INITIATE ───────────────────────────────────
const SIGNUP_CODE_SENT = 'A verification code has been sent to your email address.';

export const signupUser = async (
  name: string,
  email: string,
  password: string
): Promise<{ email: string; message: string; verificationTicket: string }> => {
  // Validate before touching the database: cheaper, and it keeps invalid input
  // from reaching the users table at all.
  validateSignupInput(name, email, password);
  const normalizedEmail = normEmail(email);

  // Hash first — the password AND the verification code — whether or not the
  // address is taken, so both paths do the same slow work. Before, only a fresh
  // signup hashed the code (bcrypt cost 12), and that ~0.3 s gap told anyone
  // which addresses are registered.
  const password_hash = await hashPassword(password);
  const code = await newEmailOtp();

  const existing = await query<User>('SELECT * FROM users WHERE lower(email) = $1', [normalizedEmail]);
  const existingUser = existing.rows[0];
  if (existingUser) {
    // Answer exactly as for a fresh signup so this form cannot be used to find
    // out which addresses are registered; the real reason stays in the log.
    // Nothing about the stored account changes, and no code is issued even if it
    // is still unverified: its password was chosen by whoever created it, which
    // may not be the owner of this inbox, so verifying it from here could hand
    // that stranger a verified account. The owner gets a notice pointing them to
    // log in or reset the password (reset proves inbox ownership and replaces
    // the password).
    logger.warn(`[AUTH] signupUser: email already registered — "${normalizedEmail}" (no account created, no code issued)`);
    if (env.EMAIL.USER && env.EMAIL.PASSWORD) {
      try {
        await sendAccountExistsNotice(existingUser.email, existingUser.name);
      } catch (noticeErr) {
        logger.warn(`[AUTH] signupUser: account-exists notice failed for "${normalizedEmail}"`, noticeErr);
      }
    }
    // A ticket that matches nothing, so the response looks the same.
    return { email: normalizedEmail, message: SIGNUP_CODE_SENT, verificationTicket: newVerificationTicket() };
  }

  const { rows } = await query<User>(
    `INSERT INTO users (name, email, password_hash, is_verified)
     VALUES ($1, $2, $3, FALSE)
     RETURNING id, name, email, avatar_url, created_at`,
    [name.trim(), normalizedEmail, password_hash]
  );
  const user = rows[0];

  const verificationTicket = newVerificationTicket();
  const otp = await issueEmailVerificationOtp(user.id, verificationTicket, code);

  if (env.NODE_ENV !== 'production') {
    logger.info(`[DEV] Signup OTP for ${user.email}: ${otp}`);
  }

  if (env.EMAIL.USER && env.EMAIL.PASSWORD) {
    try {
      await sendSignupVerificationOtp(user.email, user.name, otp);
    } catch (emailErr) {
      // Same response as a delivered code (an existing account never reports
      // delivery trouble either); the form's "Resend code" is the recovery path.
      logger.warn(`[AUTH] signupUser: verification email failed for "${normalizedEmail}"`, emailErr);
    }
  }

  return { email: user.email, message: SIGNUP_CODE_SENT, verificationTicket };
};

// ── SIGNUP: RESEND OTP ────────────────────────────────
export const resendSignupOtp = async (email: string, ticket: string | undefined): Promise<void> => {
  const { rows } = await query<User>('SELECT * FROM users WHERE lower(email) = $1', [normEmail(email)]);
  const user = rows[0];
  // Unknown and already-verified addresses get the same silent success as a real
  // pending signup, so this endpoint cannot be used to probe accounts. The real
  // reason stays in the log.
  // A code is only re-sent to the browser the previous one was issued to.
  if (!user || user.is_verified || !(await ticketMatchesLatestCode(user.id, ticket))) {
    logger.warn(`[AUTH] resendSignupOtp: nothing to resend for "${email}" (${!user ? 'unknown email' : user.is_verified ? 'already verified' : 'ticket does not match'})`);
    await bcrypt.compare('x', DUMMY_PASSWORD_HASH);
    return;
  }

  const otp = await issueEmailVerificationOtp(user.id, ticket!);

  if (env.NODE_ENV !== 'production') {
    logger.info(`[DEV] Signup Resend OTP for ${user.email}: ${otp}`);
  }

  if (env.EMAIL.USER && env.EMAIL.PASSWORD) {
    try {
      await sendSignupVerificationOtp(user.email, user.name, otp);
    } catch (emailErr) {
      logger.warn(`[AUTH] resendSignupOtp: failed to send OTP email to "${email}"`, emailErr);
      if (env.NODE_ENV === 'production') {
        throw new AppError('Failed to send verification email. Please try again.', 500);
      }
    }
  }
};

// ── LOGIN: RESEND EMAIL VERIFICATION OTP ──────────────
export const resendLoginOtp = async (email: string, ticket: string | undefined): Promise<number> => {
  const { rows } = await query<User>('SELECT * FROM users WHERE lower(email) = $1', [normEmail(email)]);
  const user = rows[0];
  if (!user || user.is_verified || !(await ticketMatchesLatestCode(user.id, ticket))) {
    logger.warn(`[AUTH] resendLoginOtp: nothing to resend for "${email}" (${!user ? 'unknown email' : user.is_verified ? 'already verified' : 'ticket does not match'})`);
    await bcrypt.compare('x', DUMMY_PASSWORD_HASH);
    return RESEND_COOLDOWN_SECONDS;
  }

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
    return Math.min(RESEND_COOLDOWN_SECONDS, Math.max(0, expiresInSeconds));
  }

  // Issue fresh OTP
  const otp = await issueEmailVerificationOtp(user.id, ticket!);

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

  return RESEND_COOLDOWN_SECONDS;
};

// ── SIGNUP: VERIFY OTP ────────────────────────────────
export const verifySignupOtp = async (
  email: string,
  code: string,
  ticket: string | undefined
): Promise<{ user: Omit<User, 'password_hash'>; accessToken: string; refreshToken: string }> => {
  logger.info(`[AUTH] verifySignupOtp: verifying signup OTP for "${email}"`);
  const { rows: userRows } = await query<User>('SELECT * FROM users WHERE lower(email) = $1', [normEmail(email)]);
  const user = userRows[0];
  if (!user) {
    logger.warn(`[AUTH] verifySignupOtp: no user found for "${email}"`);
    throw new AppError(OTP_REJECTED, 400);
  }

  // Only a code issued to this browser counts (see VERIFY_TICKET_COOKIE).
  const { rows: tokenRows } = await query<EmailVerificationToken>(
    `SELECT * FROM email_verification_tokens
     WHERE user_id = $1 AND used = FALSE AND ticket_hash = $2
     ORDER BY created_at DESC LIMIT 1`,
    [user.id, hashToken(ticket ?? '')]
  );
  const token = tokenRows[0];
  if (!ticket || !token) throw new AppError(OTP_REJECTED, 400);

  if (new Date(token.expires_at) < new Date()) {
    await query('UPDATE email_verification_tokens SET used = TRUE WHERE id = $1', [token.id]);
    throw new AppError(OTP_REJECTED, 400);
  }

  const attemptNo = await reserveOtpAttempt('email_verification_tokens', token.id);
  if (attemptNo === null) throw new AppError(OTP_REJECTED, 400);

  const valid = await bcrypt.compare(code, token.code_hash);
  if (!valid) {
    logger.warn(`[AUTH] verifySignupOtp: invalid OTP code for "${email}" (attempt ${attemptNo}/${OTP_MAX_ATTEMPTS})`);
    await rejectWrongOtp('email_verification_tokens', token.id, attemptNo);
  }

  // Atomic: consume token + mark user verified. The token is consumed first and
  // must flip exactly one row, so a second concurrent correct guess cannot also
  // mint a session from the same code.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const consumed = await client.query(
      'UPDATE email_verification_tokens SET used = TRUE WHERE id = $1 AND used = FALSE',
      [token.id]
    );
    if (consumed.rowCount !== 1) throw new AppError(OTP_REJECTED, 400);
    await client.query('UPDATE users SET is_verified = TRUE WHERE id = $1', [user.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`[AUTH] verifySignupOtp: transaction failed for "${email}"`, err);
    throw err;
  } finally {
    client.release();
  }
  logger.info(`[AUTH] ✅ Signup OTP verified — user "${email}" is now verified`);

  const { rows: freshRows } = await query<User>('SELECT * FROM users WHERE id = $1', [user.id]);
  const freshUser = freshRows[0];

  const accessToken  = generateAccessToken(freshUser.id, freshUser.role);
  const refreshToken = generateRefreshToken(freshUser.id, freshUser.role);
  await storeRefreshToken(freshUser.id, refreshToken);

  const { password_hash: _, ...safeUser } = freshUser;
  return { user: safeUser, accessToken, refreshToken };
};

// ── GOOGLE OAUTH ──────────────────────────────────────
// The caller has already checked that Google verified the address.
//  - google_id already linked          → sign in.
//  - no account with this email        → create one (verified).
//  - unverified local account          → nobody has proven owning that inbox,
//    and its password may be a stranger's; Google just proved it, so the
//    account is claimed: linked, verified, password removed, sessions revoked.
//  - verified local account, or one linked to a different Google account →
//    refused. Attaching a Google identity to an account its owner has already
//    secured needs an explicit, authenticated linking step, never a match on
//    the email alone.
type GoogleOAuthResult =
  | { status: 'AUTHENTICATED'; user: Omit<User, 'password_hash'>; accessToken: string; refreshToken: string }
  | { status: 'ACCOUNT_EXISTS' };

export const googleOAuthUser = async (profile: {
  googleId: string;
  name: string;
  email: string;
  avatarUrl?: string;
}): Promise<GoogleOAuthResult> => {
  const { googleId, name, avatarUrl } = profile;
  const email = normEmail(profile.email);
  logger.info(`[AUTH] googleOAuthUser: email="${email}" googleId="${googleId}"`);

  let user: User | undefined = (await query<User>('SELECT * FROM users WHERE google_id = $1', [googleId])).rows[0];

  if (user) {
    logger.info(`[AUTH] googleOAuthUser: existing linked user "${email}" (id=${user.id})`);
  } else {
    const byEmail = (await query<User>('SELECT * FROM users WHERE lower(email) = $1', [email])).rows[0];
    if (byEmail && (byEmail.is_verified || byEmail.google_id)) {
      logger.warn(`[AUTH] googleOAuthUser: refused to auto-link Google account to existing ${byEmail.google_id ? 'Google-linked' : 'verified'} account "${email}" (id=${byEmail.id})`);
      return { status: 'ACCOUNT_EXISTS' };
    }
    if (byEmail) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: claimed } = await client.query<User>(
          `UPDATE users SET google_id = $1, is_verified = TRUE, password_hash = NULL
           WHERE id = $2 AND is_verified = FALSE AND google_id IS NULL
           RETURNING *`,
          [googleId, byEmail.id]
        );
        if (!claimed[0]) {
          await client.query('ROLLBACK');
          return { status: 'ACCOUNT_EXISTS' };
        }
        await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [byEmail.id]);
        await client.query('UPDATE email_verification_tokens SET used = TRUE WHERE user_id = $1 AND used = FALSE', [byEmail.id]);
        await client.query('COMMIT');
        user = claimed[0];
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      logger.info(`[AUTH] googleOAuthUser: unverified account "${email}" claimed via Google (id=${user.id}); its password was removed`);
    } else {
      const { rows: newRows } = await query<User>(
        `INSERT INTO users (name, email, google_id, avatar_url, is_verified)
         VALUES ($1, $2, $3, $4, TRUE)
         RETURNING *`,
        [name.trim(), email, googleId, avatarUrl ?? null]
      );
      user = newRows[0];
      logger.info(`[AUTH] googleOAuthUser: new user created "${email}" (id=${user.id})`);
    }
  }

  const accessToken  = generateAccessToken(user.id, user.role);
  const refreshToken = generateRefreshToken(user.id, user.role);
  await storeRefreshToken(user.id, refreshToken);

  const { password_hash: _, ...safeUser } = user;
  return { status: 'AUTHENTICATED', user: safeUser, accessToken, refreshToken };
};

// ── HELPER ────────────────────────────────────────────
// At most this many concurrent sessions (families) per user; the oldest go first.
const MAX_SESSIONS_PER_USER = 10;
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

type Queryable = Pick<PoolClient, 'query'>;

const insertRefreshToken = async (db: Queryable, userId: string, token: string, familyId: string) => {
  await db.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at) VALUES ($1, $2, $3, $4)',
    [userId, hashToken(token), familyId, new Date(Date.now() + REFRESH_TOKEN_TTL_MS)]
  );
};

// A new login: a new family, then housekeeping for this user — drop expired rows
// and evict the oldest sessions beyond the cap.
const storeRefreshToken = async (userId: string, token: string) => {
  await insertRefreshToken(pool, userId, token, crypto.randomUUID());
  await query('DELETE FROM refresh_tokens WHERE user_id = $1 AND expires_at <= NOW()', [userId]);
  await query(
    `DELETE FROM refresh_tokens
     WHERE user_id = $1 AND family_id IN (
       SELECT family_id FROM refresh_tokens
       WHERE user_id = $1 AND rotated_at IS NULL
       ORDER BY created_at DESC
       OFFSET $2)`,
    [userId, MAX_SESSIONS_PER_USER]
  );
};

// ── UPDATE PROFILE ────────────────────────────────────
export const updateProfile = async (
  userId: string,
  params: { name?: string; currentPassword?: string; newPassword?: string; avatarUrl?: string },
  // The caller's refresh cookie: after a password change, every session except
  // this one is ended (revokeOtherSessions).
  currentRefreshToken?: string
): Promise<Pick<User, 'id' | 'name' | 'email' | 'role' | 'avatar_url'>> => {
  const { name, currentPassword, newPassword, avatarUrl } = params;

  const { rows } = await query<User>('SELECT * FROM users WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user) throw new AppError('User not found', 404);

  if (newPassword) {
    if (!currentPassword) throw new AppError('Current password is required to set a new one.', 400);
    if (!user.password_hash) throw new AppError('This account uses Google sign-in and has no password to change.', 400);
    const valid = await comparePassword(currentPassword, user.password_hash);
    if (!valid) throw new AppError('Current password is incorrect.', 401);
    validatePassword(newPassword, 'New password');
  }

  const newHash = newPassword ? await hashPassword(newPassword) : null;

  const { rows: updated } = await query<Pick<User, 'id' | 'name' | 'email' | 'role' | 'avatar_url'>>(
    `UPDATE users
     SET name        = COALESCE($1, name),
         password_hash = CASE WHEN $2::text IS NOT NULL THEN $2 ELSE password_hash END,
         avatar_url  = COALESCE($3, avatar_url)
     WHERE id = $4
     RETURNING id, name, email, role, avatar_url`,
    [name?.trim() || null, newHash, avatarUrl ?? null, userId]
  );
  if (newHash) await revokeOtherSessions(userId, currentRefreshToken);

  logger.info(`[AUTH] ✅ Profile updated for user ${userId}`);
  return updated[0];
};
