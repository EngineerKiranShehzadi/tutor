/**
 * Auth hardening tests (docs: auth-fixes-handoff, items 2–21 backend side)
 * against a REAL Postgres: the service functions, and the REST routes through
 * the real Express app (createApp(), as server.ts) on an ephemeral port.
 *
 * OTP codes are random and only stored hashed, so a case that needs the right
 * code overwrites the newest code_hash with a known one (setCode()).
 *
 * Environment set below, before anything loads config/env.ts:
 *   EMAIL_USER/EMAIL_PASSWORD blank  → no real email is ever sent;
 *   BCRYPT_SALT_ROUNDS=4             → fast password hashing;
 *   AUTH_RATE_LIMIT_MAX=1000         → the REST auth limiter does not trip.
 *
 * SAFETY: refuses to run unless the target database is local and its name
 * contains "test"/"pipe" (test-db-guard-lib.ts). Everything it creates uses
 * @auth-hardening.test addresses and is deleted at the end.
 *
 * Usage: DATABASE_URL=postgresql://...localhost.../askai_pipe_x \
 *          node_modules/.bin/ts-node --transpile-only src/scripts/test-auth-hardening.ts
 */
import { assertThrowawayDb } from './test-db-guard-lib';

assertThrowawayDb('test-auth-hardening');
process.env.EMAIL_USER = '';
process.env.EMAIL_PASSWORD = '';
process.env.BCRYPT_SALT_ROUNDS = '4';
process.env.AUTH_RATE_LIMIT_MAX = '1000';

import { spawnSync } from 'child_process';
import * as path from 'path';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool, { query } from '../config/database';
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';
import * as Auth from '../services/auth.service';
import { updateUserRole, updateAdminProfile } from '../services/user.service';
import { generateAccessToken, generateRefreshToken, verifyAccessToken, verifyRefreshToken } from '../utils/jwt';
import { hashToken } from '../utils/password';
import { createApp } from '../app';
import { readFileSync } from 'fs';

const DOMAIN = '@auth-hardening.test';
const PW = 'GoodPass1';
let seq = 0;
const addr = (tag: string): string => `${tag}-${Date.now()}-${++seq}${DOMAIN}`;

interface CaseResult { pass: boolean; detail?: string }
interface Case { label: string; run: (base: string) => Promise<CaseResult> }
const cases: Case[] = [];
const test = (label: string, run: Case['run']): void => { cases.push({ label, run }); };

// ── helpers ──────────────────────────────────────────────────────────────
const errOf = async (p: Promise<unknown>): Promise<AppError | Error | null> => {
  try { await p; return null; } catch (e) { return e as Error; }
};

const insertUser = async (email: string, opts: { verified?: boolean; googleId?: string | null; password?: string | null; role?: string } = {}): Promise<string> => {
  const hash = opts.password === null ? null : await bcrypt.hash(opts.password ?? PW, 4);
  const { rows } = await query<{ id: string }>(
    `INSERT INTO users (name, email, password_hash, is_verified, google_id, role)
     VALUES ('Test User', $1, $2, $3, $4, $5) RETURNING id`,
    [email.toLowerCase(), hash, opts.verified ?? true, opts.googleId ?? null, opts.role ?? 'STUDENT']
  );
  return rows[0].id;
};

const userByEmail = async (email: string) =>
  (await query<{ id: string; password_hash: string | null; is_verified: boolean; google_id: string | null; role: string }>(
    'SELECT * FROM users WHERE email = $1', [email.toLowerCase()])).rows[0];

type OtpTable = 'password_reset_tokens' | 'email_verification_tokens';
const setCode = async (table: OtpTable, userId: string, code: string): Promise<void> => {
  await query(
    `UPDATE ${table} SET code_hash = $2
     WHERE id = (SELECT id FROM ${table} WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)`,
    [userId, bcrypt.hashSync(code, 4)]
  );
};
const latestCode = async (table: OtpTable, userId: string) =>
  (await query<{ id: string; attempts: number; used: boolean; expires_at: Date; verified?: boolean }>(
    `SELECT * FROM ${table} WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [userId])).rows[0];
const count = async (sql: string, params: unknown[]): Promise<number> =>
  Number((await query<{ n: string }>(sql, params)).rows[0].n);

const login = async (email: string) => {
  const r = await Auth.loginUser(email, PW);
  if (r.status !== 'AUTHENTICATED') throw new Error(`expected AUTHENTICATED, got ${r.status}`);
  return r;
};

// An unverified signup, returning the user id, its ticket and a known code.
const pendingSignup = async (email: string) => {
  const r = await Auth.signupUser('Test User', email, PW);
  const u = await userByEmail(email);
  await setCode('email_verification_tokens', u.id, '111111');
  return { id: u.id, ticket: r.verificationTicket };
};

const cookieValue = (res: Response, name: string): string | undefined => {
  const all = res.headers.getSetCookie?.() ?? [];
  const hit = all.find(c => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.split(';')[0].slice(name.length + 1)) : undefined;
};

// ── 8: REST /register is gone ───────────────────────────────────────────
test('#8 POST /auth/register no longer exists (404) and creates no user', async (base) => {
  const email = addr('register');
  const res = await fetch(`${base}/api/v1/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'X Y', email, password: PW }),
  });
  const u = await userByEmail(email);
  return { pass: res.status === 404 && !u && !res.headers.get('set-cookie'), detail: `status=${res.status} user=${!!u}` };
});

// ── 9: reset needs an unexpired verified token, spent once ──────────────
test('#9 a verified reset token past expires_at cannot reset the password', async () => {
  const email = addr('reset-exp');
  const id = await insertUser(email);
  await Auth.requestPasswordReset(email);
  await setCode('password_reset_tokens', id, '222222');
  const ticket = await Auth.verifyOtp(email, '222222');
  await query(`UPDATE password_reset_tokens SET expires_at = NOW() - INTERVAL '1 hour' WHERE user_id = $1`, [id]);
  const e = await errOf(Auth.resetPasswordWithOtp(email, 'NewPass12', 'NewPass12', ticket));
  const u = await userByEmail(email);
  return { pass: !!e && await bcrypt.compare(PW, u.password_hash!), detail: e?.message };
});

test('#9 an unexpired verified token resets once, revokes sessions, then is spent', async () => {
  const email = addr('reset-ok');
  const id = await insertUser(email);
  await login(email);
  await Auth.requestPasswordReset(email);
  await setCode('password_reset_tokens', id, '333333');
  const ticket = await Auth.verifyOtp(email, '333333');
  await Auth.resetPasswordWithOtp(email, 'NewPass12', 'NewPass12', ticket);
  const again = await errOf(Auth.resetPasswordWithOtp(email, 'Other123', 'Other123', ticket));
  const u = await userByEmail(email);
  const sessions = await count('SELECT COUNT(*) n FROM refresh_tokens WHERE user_id = $1', [id]);
  return { pass: await bcrypt.compare('NewPass12', u.password_hash!) && !!again && sessions === 0, detail: `second=${again?.message} sessions=${sessions}` };
});

test('#9 two concurrent resets with one verified token: exactly one succeeds', async () => {
  const email = addr('reset-race');
  const id = await insertUser(email);
  await Auth.requestPasswordReset(email);
  await setCode('password_reset_tokens', id, '444444');
  const ticket = await Auth.verifyOtp(email, '444444');
  const results = await Promise.allSettled([
    Auth.resetPasswordWithOtp(email, 'RaceAaa11', 'RaceAaa11', ticket),
    Auth.resetPasswordWithOtp(email, 'RaceBbb22', 'RaceBbb22', ticket),
  ]);
  const ok = results.filter(r => r.status === 'fulfilled').length;
  return { pass: ok === 1, detail: `fulfilled=${ok}` };
});

test('R3 a reset on a squatted unverified account verifies it in one step', async () => {
  const email = addr('reclaim');
  const s = await pendingSignup(email);               // squatter's unverified account + pending code
  await Auth.requestPasswordReset(email);             // the inbox owner
  await setCode('password_reset_tokens', s.id, '777777');
  const ticket = await Auth.verifyOtp(email, '777777');
  await Auth.resetPasswordWithOtp(email, 'OwnerPass9', 'OwnerPass9', ticket);
  const u = await userByEmail(email);
  const pending = await count('SELECT COUNT(*) n FROM email_verification_tokens WHERE user_id = $1 AND used = FALSE', [s.id]);
  const r = await Auth.loginUser(email, 'OwnerPass9');
  const old = await errOf(Auth.loginUser(email, PW));
  return { pass: u.is_verified && pending === 0 && r.status === 'AUTHENTICATED' && !!old, detail: `verified=${u.is_verified} pendingCodes=${pending} login=${r.status}` };
});

test('R2 a reset request for an unknown email is not markedly faster than for a real one', async () => {
  const real = addr('reset-timing');
  await insertUser(real);
  const time = async (email: string) => { const t = Date.now(); await Auth.requestPasswordReset(email); return Date.now() - t; };
  const missing: number[] = [], known: number[] = [];
  for (let i = 0; i < 5; i++) { missing.push(await time(addr('nobody'))); known.push(await time(real)); }
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[2];
  const ratio = (med(missing) + 1) / (med(known) + 1);
  return { pass: ratio > 0.7, detail: `missing≈${med(missing)}ms known≈${med(known)}ms` };
});

// ── 6: 5-minute OTP lifetime, 60 s resend cooldown ──────────────────────
test('#6 reset and signup codes live 5 minutes', async () => {
  const email = addr('ttl');
  const id = await insertUser(email);
  await Auth.requestPasswordReset(email);
  const pr = await latestCode('password_reset_tokens', id);
  const s = await pendingSignup(addr('ttl-signup'));
  const ev = await latestCode('email_verification_tokens', s.id);
  const secs = (d: Date) => Math.round((new Date(d).getTime() - Date.now()) / 1000);
  const a = secs(pr.expires_at), b = secs(ev.expires_at);
  return { pass: a > 280 && a <= 300 && b > 280 && b <= 300, detail: `reset=${a}s signup=${b}s` };
});

test('#6 login of an unverified account reports a 60 s cooldown, also when reusing a live code', async () => {
  const email = addr('cooldown');
  await insertUser(email, { verified: false });
  const first = await Auth.loginUser(email, PW);
  const second = await Auth.loginUser(email, PW);
  const f = first.status === 'EMAIL_VERIFICATION_REQUIRED' ? first.verificationExpiresInSeconds : -1;
  const s = second.status === 'EMAIL_VERIFICATION_REQUIRED' ? second.verificationExpiresInSeconds : -1;
  return { pass: f === 60 && s > 0 && s <= 60, detail: `first=${f} second=${s}` };
});

// ── 10 / 18: one password policy everywhere ─────────────────────────────
test('#10 reset rejects a weak password and one over 72 bytes', async () => {
  const email = addr('reset-weak');
  const id = await insertUser(email);
  await Auth.requestPasswordReset(email);
  await setCode('password_reset_tokens', id, '555555');
  const ticket = await Auth.verifyOtp(email, '555555');
  const weak = await errOf(Auth.resetPasswordWithOtp(email, 'a', 'a', ticket));
  const long = 'Aa1' + 'x'.repeat(70);
  const tooLong = await errOf(Auth.resetPasswordWithOtp(email, long, long, ticket));
  const u = await userByEmail(email);
  return { pass: !!weak && !!tooLong && await bcrypt.compare(PW, u.password_hash!), detail: `${weak?.message} | ${tooLong?.message}` };
});

test('#18 updateProfile and updateAdminProfile enforce the same policy', async () => {
  const sid = await insertUser(addr('profile'));
  const aid = await insertUser(addr('admin-profile'), { role: 'ADMIN' });
  const e1 = await errOf(Auth.updateProfile(sid, { currentPassword: PW, newPassword: 'alllowercase1' }));
  const e2 = await errOf(updateAdminProfile(aid, undefined, PW, 'short'));
  const e3 = await errOf(updateAdminProfile(aid, undefined, PW, 'NoDigitsHere'));
  const ok = await errOf(Auth.updateProfile(sid, { currentPassword: PW, newPassword: 'Changed123' }));
  return { pass: !!e1 && !!e2 && !!e3 && ok === null, detail: `${e1?.message} | ${e2?.message} | ${e3?.message}` };
});

// ── 3: OTP guess cap ────────────────────────────────────────────────────
test('#3 reset code: 5 wrong guesses burn it; the right code is then refused', async () => {
  const email = addr('guess-reset');
  const id = await insertUser(email);
  await Auth.requestPasswordReset(email);
  await setCode('password_reset_tokens', id, '666666');
  for (let i = 0; i < 5; i++) await errOf(Auth.verifyOtp(email, '000000'));
  const right = await errOf(Auth.verifyOtp(email, '666666'));
  const t = await latestCode('password_reset_tokens', id);
  return { pass: !!right && t.used && t.attempts === 5, detail: `attempts=${t.attempts} used=${t.used}` };
});

test('#3 signup code: 4 wrong guesses then the right one still verifies', async () => {
  const s = await pendingSignup(addr('guess-signup'));
  const email = (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [s.id])).rows[0].email;
  for (let i = 0; i < 4; i++) await errOf(Auth.verifySignupOtp(email, '000000', s.ticket));
  const r = await Auth.verifySignupOtp(email, '111111', s.ticket);
  return { pass: !!r.accessToken && (await userByEmail(email)).is_verified };
});

test('#3 20 parallel wrong guesses cannot exceed the 5-guess cap', async () => {
  const s = await pendingSignup(addr('guess-parallel'));
  const email = (await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [s.id])).rows[0].email;
  await Promise.allSettled(Array.from({ length: 20 }, () => Auth.verifySignupOtp(email, '000000', s.ticket)));
  const t = await latestCode('email_verification_tokens', s.id);
  const right = await errOf(Auth.verifySignupOtp(email, '111111', s.ticket));
  return { pass: t.attempts === 5 && t.used && !!right, detail: `attempts=${t.attempts} used=${t.used}` };
});

// ── 2: no account enumeration ───────────────────────────────────────────
test('#2 reset request for an unknown email succeeds silently and stores nothing', async () => {
  const e = await errOf(Auth.requestPasswordReset(addr('nobody')));
  const e2 = await errOf(Auth.resendPasswordResetOtp(addr('nobody')));
  return { pass: e === null && e2 === null };
});

test('#2 every OTP failure returns one message (unknown email, wrong, expired)', async () => {
  const unknown = await errOf(Auth.verifyOtp(addr('nobody'), '123456'));
  const email = addr('uniform');
  const id = await insertUser(email);
  await Auth.requestPasswordReset(email);
  const wrong = await errOf(Auth.verifyOtp(email, '000000'));
  await query(`UPDATE password_reset_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1`, [id]);
  const expired = await errOf(Auth.verifyOtp(email, '000000'));
  const resetUnknown = await errOf(Auth.resetPasswordWithOtp(addr('nobody'), 'NewPass12', 'NewPass12', 'some-ticket'));
  const msgs = new Set([unknown?.message, wrong?.message, expired?.message, resetUnknown?.message]);
  return { pass: msgs.size === 1 && !msgs.has(undefined), detail: [...msgs].join(' | ') };
});

test('#2 resendSignupOtp / resendLoginOtp: unknown and verified addresses answer like a real one', async () => {
  const verified = addr('verified');
  await insertUser(verified);
  const a = await errOf(Auth.resendSignupOtp(addr('nobody'), undefined));
  const b = await errOf(Auth.resendSignupOtp(verified, undefined));
  const c = await Auth.resendLoginOtp(addr('nobody'), undefined);
  const d = await Auth.resendLoginOtp(verified, undefined);
  return { pass: a === null && b === null && c === 60 && d === 60, detail: `${c} ${d}` };
});

test('#2 signup with a registered address: same answer, no new user, password and codes untouched', async () => {
  const email = addr('dup');
  const id = await insertUser(email, { verified: false });
  const before = (await userByEmail(email)).password_hash;
  const fresh = await Auth.signupUser('Someone Else', addr('fresh'), PW);
  const dup = await Auth.signupUser('Someone Else', email.toUpperCase(), 'Different1');
  const users = await count('SELECT COUNT(*) n FROM users WHERE lower(email) = lower($1)', [email]);
  const codes = await count('SELECT COUNT(*) n FROM email_verification_tokens WHERE user_id = $1', [id]);
  const after = (await userByEmail(email)).password_hash;
  return {
    pass: fresh.message === dup.message && users === 1 && codes === 0 && before === after && !!dup.verificationTicket,
    detail: `users=${users} codes=${codes}`,
  };
});

// ── verification ticket (pre-hijack guard) ─────────────────────────────
test('ticket: a signup code only verifies with the ticket of the browser that requested it', async () => {
  const email = addr('ticket');
  const s = await pendingSignup(email);
  const none = await errOf(Auth.verifySignupOtp(email, '111111', undefined));
  const other = await errOf(Auth.verifySignupOtp(email, '111111', 'not-the-ticket'));
  const ok = await Auth.verifySignupOtp(email, '111111', s.ticket);
  return { pass: !!none && !!other && !!ok.accessToken };
});

test('ticket: a stranger-created unverified account cannot be resent a code without its ticket', async () => {
  const email = addr('prehijack');
  const s = await pendingSignup(email);                 // the "stranger"
  const victim = await Auth.signupUser('Victim', email, 'VictimPw1');   // owner tries to sign up
  const codesBefore = await count('SELECT COUNT(*) n FROM email_verification_tokens WHERE user_id = $1', [s.id]);
  await Auth.resendSignupOtp(email, victim.verificationTicket);
  await Auth.resendLoginOtp(email, victim.verificationTicket);
  const codesAfter = await count('SELECT COUNT(*) n FROM email_verification_tokens WHERE user_id = $1', [s.id]);
  const verify = await errOf(Auth.verifySignupOtp(email, '111111', victim.verificationTicket));
  return { pass: codesBefore === codesAfter && !!verify && !(await userByEmail(email)).is_verified, detail: `codes ${codesBefore}->${codesAfter}` };
});

test('ticket: login with the right password re-binds the live code to the new browser', async () => {
  const email = addr('rebind');
  const s = await pendingSignup(email);
  const r = await Auth.loginUser(email, PW);
  if (r.status !== 'EMAIL_VERIFICATION_REQUIRED') return { pass: false, detail: r.status };
  const oldTicket = await errOf(Auth.verifySignupOtp(email, '111111', s.ticket));
  const ok = await Auth.verifySignupOtp(email, '111111', r.verificationTicket);
  return { pass: !!oldTicket && !!ok.accessToken };
});

// ── 16: login uniformity ────────────────────────────────────────────────
test('#16 unknown, Google-only and wrong-password logins get the same message', async () => {
  const google = addr('google-only');
  await insertUser(google, { password: null, googleId: `g-${Date.now()}` });
  const real = addr('real');
  await insertUser(real);
  const m = await Promise.all([
    errOf(Auth.loginUser(addr('nobody'), PW)),
    errOf(Auth.loginUser(google, PW)),
    errOf(Auth.loginUser(real, 'WrongPass1')),
  ]);
  const msgs = new Set(m.map(e => e?.message));
  return { pass: msgs.size === 1 && !msgs.has(undefined), detail: [...msgs].join(' | ') };
});

test('#16 a missing account still pays for a bcrypt compare (not markedly faster)', async () => {
  const real = addr('timing');
  await insertUser(real);
  const time = async (email: string) => { const t = Date.now(); await errOf(Auth.loginUser(email, 'WrongPass1')); return Date.now() - t; };
  // DUMMY_PASSWORD_HASH uses BCRYPT_SALT_ROUNDS (4 here), as real hashes do.
  const missing: number[] = [], wrong: number[] = [];
  for (let i = 0; i < 5; i++) { missing.push(await time(addr('nobody'))); wrong.push(await time(real)); }
  const med = (a: number[]) => a.sort((x, y) => x - y)[2];
  const ratio = (med(missing) + 1) / (med(wrong) + 1);
  return { pass: ratio > 0.5, detail: `missing≈${med(missing)}ms wrong≈${med(wrong)}ms` };
});

// ── 4 / 11 / 21: refresh rotation ───────────────────────────────────────
test('#4a refresh mints the role from the database, not the old token', async () => {
  const email = addr('role-refresh');
  const id = await insertUser(email);
  const { refreshToken } = await login(email);
  await query(`UPDATE users SET role = 'ADMIN' WHERE id = $1`, [id]);
  const r = await Auth.refreshAccessToken(refreshToken);
  return { pass: verifyAccessToken(r.accessToken).role === 'ADMIN' && verifyRefreshToken(r.refreshToken).role === 'ADMIN' };
});

test('#4b changing a role revokes the user\'s refresh tokens (unchanged role does not)', async () => {
  const adminId = await insertUser(addr('admin'), { role: 'ADMIN' });
  const email = addr('demote');
  const id = await insertUser(email);
  await login(email);
  await updateUserRole(id, 'STUDENT', adminId);
  const kept = await count('SELECT COUNT(*) n FROM refresh_tokens WHERE user_id = $1', [id]);
  await updateUserRole(id, 'ADMIN', adminId);
  const left = await count('SELECT COUNT(*) n FROM refresh_tokens WHERE user_id = $1', [id]);
  return { pass: kept === 1 && left === 0, detail: `same-role=${kept} after-change=${left}` };
});

test('#11 replaying a rotated token (after the grace window) revokes the whole family', async () => {
  const email = addr('reuse');
  await insertUser(email);
  const { refreshToken: t1 } = await login(email);
  const { refreshToken: other } = await login(email);       // a second, unrelated session
  const { refreshToken: t2 } = await Auth.refreshAccessToken(t1);
  await query(`UPDATE refresh_tokens SET rotated_at = NOW() - INTERVAL '1 minute' WHERE token_hash = $1`, [hashToken(t1)]);
  const replay = await errOf(Auth.refreshAccessToken(t1));
  const successor = await errOf(Auth.refreshAccessToken(t2));
  const otherOk = await errOf(Auth.refreshAccessToken(other));
  return { pass: !!replay && !!successor && otherOk === null, detail: `replay=${replay?.message} successor=${successor?.message ?? 'ok'} otherSession=${otherOk?.message ?? 'ok'}` };
});

test('#11 a replay inside the grace window is refused but revokes nothing', async () => {
  const email = addr('grace');
  await insertUser(email);
  const { refreshToken: t1 } = await login(email);
  const { refreshToken: t2 } = await Auth.refreshAccessToken(t1);
  const replay = await errOf(Auth.refreshAccessToken(t1));
  const successor = await errOf(Auth.refreshAccessToken(t2));
  return { pass: (replay as AppError | null)?.statusCode === 409 && successor === null, detail: replay?.message };
});

test('#21 10 concurrent refreshes of one token mint exactly one successor', async () => {
  const email = addr('concurrent');
  const id = await insertUser(email);
  const { refreshToken } = await login(email);
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => Auth.refreshAccessToken(refreshToken)));
  const ok = results.filter(r => r.status === 'fulfilled').length;
  const live = await count('SELECT COUNT(*) n FROM refresh_tokens WHERE user_id = $1 AND rotated_at IS NULL', [id]);
  return { pass: ok === 1 && live === 1, detail: `fulfilled=${ok} live=${live}` };
});

test('refresh tokens minted in the same second differ (jti)', async () => {
  const a = generateRefreshToken('00000000-0000-0000-0000-000000000000', 'STUDENT');
  const b = generateRefreshToken('00000000-0000-0000-0000-000000000000', 'STUDENT');
  return { pass: a !== b };
});

// ── 17: purge + per-user cap ────────────────────────────────────────────
test('#17 a user keeps at most 10 sessions; expired rows are purged', async () => {
  const email = addr('cap');
  const id = await insertUser(email);
  for (let i = 0; i < 12; i++) await login(email);
  const live = await count('SELECT COUNT(*) n FROM refresh_tokens WHERE user_id = $1', [id]);
  await query(`UPDATE refresh_tokens SET expires_at = NOW() - INTERVAL '1 second' WHERE user_id = $1`, [id]);
  const purged = await Auth.purgeExpiredRefreshTokens();
  const after = await count('SELECT COUNT(*) n FROM refresh_tokens WHERE user_id = $1', [id]);
  return { pass: live === 10 && purged >= 10 && after === 0, detail: `live=${live} purged=${purged} after=${after}` };
});

// ── 12: logout by refresh cookie, logout-all ───────────────────────────
test('#12 POST /logout with only the refresh cookie (no access token) ends the session', async (base) => {
  const email = addr('logout');
  const id = await insertUser(email);
  const { refreshToken } = await login(email);
  await login(email);                                       // another device
  const res = await fetch(`${base}/api/v1/auth/logout`, { method: 'POST', headers: { Cookie: `refreshToken=${encodeURIComponent(refreshToken)}` } });
  const gone = await errOf(Auth.refreshAccessToken(refreshToken));
  const others = await count('SELECT COUNT(*) n FROM refresh_tokens WHERE user_id = $1', [id]);
  return { pass: res.status === 200 && !!gone && others === 1, detail: `status=${res.status} otherDevices=${others}` };
});

test('#12 POST /logout-all ends every session of the cookie\'s owner', async (base) => {
  const email = addr('logout-all');
  const id = await insertUser(email);
  const { refreshToken } = await login(email);
  await login(email);
  await login(email);
  const res = await fetch(`${base}/api/v1/auth/logout-all`, { method: 'POST', headers: { Cookie: `refreshToken=${encodeURIComponent(refreshToken)}` } });
  const left = await count('SELECT COUNT(*) n FROM refresh_tokens WHERE user_id = $1', [id]);
  return { pass: res.status === 200 && left === 0, detail: `status=${res.status} left=${left}` };
});

// ── 14: JWT pinning ─────────────────────────────────────────────────────
test('#14 tokens with alg=none, a foreign audience, or the other token type are rejected', async () => {
  const none = jwt.sign({ userId: 'x', role: 'ADMIN' }, '', { algorithm: 'none' } as jwt.SignOptions);
  const noAud = jwt.sign({ userId: 'x', role: 'ADMIN' }, env.JWT.SECRET, { algorithm: 'HS256', issuer: 'askaitutor-api' });
  const access = generateAccessToken('00000000-0000-0000-0000-000000000000', 'STUDENT');
  const hs512 = jwt.sign({ userId: 'x', role: 'ADMIN' }, env.JWT.SECRET, { algorithm: 'HS512', issuer: 'askaitutor-api', audience: 'askaitutor-access' });
  const rejected = [
    () => verifyAccessToken(none), () => verifyAccessToken(noAud), () => verifyAccessToken(hs512),
    () => verifyRefreshToken(access),
  ].filter(f => { try { f(); return false; } catch { return true; } }).length;
  return { pass: rejected === 4 && verifyAccessToken(access).userId !== undefined, detail: `rejected=${rejected}/4` };
});

// ── 15: secret strength at boot ─────────────────────────────────────────
test('#15 production refuses to load env with a short JWT secret, or equal secrets', async () => {
  const run = (extra: Record<string, string>) => spawnSync(
    path.join(__dirname, '..', '..', 'node_modules', '.bin', 'ts-node'),
    ['--transpile-only', '-e', "require('./src/config/env')"],
    { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, ...extra }, encoding: 'utf8' }
  );
  const strong = 'a'.repeat(40), strong2 = 'b'.repeat(40);
  const short = run({ NODE_ENV: 'production', JWT_SECRET: 'short', JWT_REFRESH_SECRET: strong2 });
  const same = run({ NODE_ENV: 'production', JWT_SECRET: strong, JWT_REFRESH_SECRET: strong });
  const good = run({ NODE_ENV: 'production', JWT_SECRET: strong, JWT_REFRESH_SECRET: strong2 });
  const devShort = run({ NODE_ENV: 'development', JWT_SECRET: 'short', JWT_REFRESH_SECRET: strong2 });
  return {
    pass: short.status !== 0 && same.status !== 0 && good.status === 0 && devShort.status === 0 && /WARNING/.test(devShort.stderr),
    detail: `short=${short.status} same=${same.status} good=${good.status} devShort=${devShort.status}`,
  };
});

// ── 5 / 13: Google OAuth ────────────────────────────────────────────────
test('#5 /auth/google sets a state cookie and sends the same state to Google', async (base) => {
  const res = await fetch(`${base}/api/v1/auth/google`, { redirect: 'manual' });
  const loc = res.headers.get('location') ?? '';
  const state = new URL(loc).searchParams.get('state');
  const cookie = cookieValue(res, 'oauth_state');
  const raw = (res.headers.getSetCookie?.() ?? []).find(c => c.startsWith('oauth_state=')) ?? '';
  return { pass: res.status === 302 && !!state && state === cookie && /HttpOnly/i.test(raw) && /SameSite=Lax/i.test(raw), detail: raw };
});

test('#5 callback without state, or with a state that does not match the cookie, is refused', async (base) => {
  const a = await fetch(`${base}/api/v1/auth/google/callback?code=abc`, { redirect: 'manual' });
  const b = await fetch(`${base}/api/v1/auth/google/callback?code=abc&state=one`, { redirect: 'manual', headers: { Cookie: 'oauth_state=two' } });
  const ok = (r: Response) => r.status === 302 && (r.headers.get('location') ?? '').includes('error=oauth_failed');
  return { pass: ok(a) && ok(b), detail: `${a.headers.get('location')} | ${b.headers.get('location')}` };
});

test('#13 Google sign-in never auto-links to a verified local account', async () => {
  const email = addr('g-verified');
  await insertUser(email);
  const r = await Auth.googleOAuthUser({ googleId: `g-${Date.now()}-a`, name: 'G', email });
  const u = await userByEmail(email);
  return { pass: r.status === 'ACCOUNT_EXISTS' && !u.google_id && await bcrypt.compare(PW, u.password_hash!), detail: r.status };
});

test('#13 Google sign-in claims an unverified local account and drops its password', async () => {
  const email = addr('g-unverified');
  await insertUser(email, { verified: false });
  const gid = `g-${Date.now()}-b`;
  const r = await Auth.googleOAuthUser({ googleId: gid, name: 'G', email });
  const u = await userByEmail(email);
  return { pass: r.status === 'AUTHENTICATED' && u.google_id === gid && u.is_verified && u.password_hash === null };
});

test('#13 a linked Google account signs in; an unknown one creates a verified user', async () => {
  const gid = `g-${Date.now()}-c`;
  const email = addr('g-new');
  const first = await Auth.googleOAuthUser({ googleId: gid, name: 'G', email });
  const again = await Auth.googleOAuthUser({ googleId: gid, name: 'G', email });
  const u = await userByEmail(email);
  return { pass: first.status === 'AUTHENTICATED' && again.status === 'AUTHENTICATED' && u.is_verified && u.google_id === gid };
});

// ── 20: case-insensitive uniqueness ─────────────────────────────────────
test('#20 the database refuses an email that differs from an existing one only by case', async () => {
  const email = addr('case');
  await insertUser(email);
  const e = await errOf(query(`INSERT INTO users (name, email, password_hash) VALUES ('X', $1, 'x')`, [email.toUpperCase()]));
  return { pass: !!e && /users_email_lower_key/.test(e.message), detail: e?.message };
});

// ── REST: the verification ticket travels only as an httpOnly cookie ───
test('POST /login for an unverified account sets verify_ticket as httpOnly and omits it from the body', async (base) => {
  const email = addr('rest-ticket');
  await insertUser(email, { verified: false });
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PW }),
  });
  const body = await res.json() as { data?: Record<string, unknown> };
  const raw = (res.headers.getSetCookie?.() ?? []).find(c => c.startsWith('verify_ticket=')) ?? '';
  return { pass: res.status === 200 && body.data?.status === 'EMAIL_VERIFICATION_REQUIRED' && !('verificationTicket' in (body.data ?? {})) && /HttpOnly/i.test(raw), detail: raw };
});


// ── AU1: the reset step needs the ticket of the browser that verified the code ──
test('AU1 reset without a ticket, or with the wrong one, fails; the verifying browser\'s ticket succeeds', async () => {
  const email = addr('reset-ticket');
  const id = await insertUser(email);
  await Auth.requestPasswordReset(email);
  await setCode('password_reset_tokens', id, '121212');
  const ticket = await Auth.verifyOtp(email, '121212');
  const none = await errOf(Auth.resetPasswordWithOtp(email, 'Attacker99', 'Attacker99', undefined));
  const wrong = await errOf(Auth.resetPasswordWithOtp(email, 'Attacker99', 'Attacker99', 'not-the-ticket'));
  const stillOld = await bcrypt.compare(PW, (await userByEmail(email)).password_hash!);
  const ok = await errOf(Auth.resetPasswordWithOtp(email, 'OwnerNew77', 'OwnerNew77', ticket));
  const u = await userByEmail(email);
  const stored = await latestCode('password_reset_tokens', id) as { ticket_hash?: string | null };
  return {
    pass: none instanceof AppError && wrong instanceof AppError && stillOld && ok === null
      && await bcrypt.compare('OwnerNew77', u.password_hash!) && stored.ticket_hash === hashToken(ticket) && ticket.length >= 40,
    detail: `none=${none?.message} wrong=${wrong?.message} ok=${ok?.message ?? 'ok'}`,
  };
});

test('AU1/AU9 a second verifyOtp on an already-verified code fails (never "verified" again)', async () => {
  const email = addr('reverify');
  const id = await insertUser(email);
  await Auth.requestPasswordReset(email);
  await setCode('password_reset_tokens', id, '131313');
  const first = await Auth.verifyOtp(email, '131313');
  const second = await errOf(Auth.verifyOtp(email, '131313'));
  const parallelEmail = addr('reverify-race');
  const pid = await insertUser(parallelEmail);
  await Auth.requestPasswordReset(parallelEmail);
  await setCode('password_reset_tokens', pid, '141414');
  const race = await Promise.allSettled([Auth.verifyOtp(parallelEmail, '141414'), Auth.verifyOtp(parallelEmail, '141414')]);
  const won = race.filter(r => r.status === 'fulfilled').length;
  return { pass: typeof first === 'string' && second instanceof AppError && second.statusCode === 400 && won === 1,
    detail: `second=${second?.message} raceWinners=${won}` };
});

test('AU1 GraphQL: verifyOtp sets reset_ticket (httpOnly, not in the body); resetPassword needs that cookie and clears it', async (base) => {
  const email = addr('gql-reset');
  const id = await insertUser(email);
  await Auth.requestPasswordReset(email);
  await setCode('password_reset_tokens', id, '151515');
  const gql = (q: string, variables: unknown, cookie?: string) => fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ query: q, variables }),
  });
  const verify = await gql('mutation($i: VerifyOtpInput!) { verifyOtp(input: $i) { success message } }', { i: { email, code: '151515' } });
  const vBody = await verify.text();
  const rawCookie = (verify.headers.getSetCookie?.() ?? []).find(c => c.startsWith('reset_ticket=')) ?? '';
  const ticket = cookieValue(verify, 'reset_ticket');
  const RESET = 'mutation($i: ResetPasswordInput!) { resetPassword(input: $i) { success } }';
  const input = { i: { email, newPassword: 'ViaGraph88', confirmPassword: 'ViaGraph88' } };
  const noCookie = await (await gql(RESET, input)).json() as { errors?: unknown[] };
  const withCookie = await gql(RESET, input, `reset_ticket=${ticket}`);
  const wBody = await withCookie.json() as { data?: { resetPassword?: { success: boolean } } };
  const cleared = (withCookie.headers.getSetCookie?.() ?? []).find(c => c.startsWith('reset_ticket=')) ?? '';
  const u = await userByEmail(email);
  return {
    pass: !!ticket && /HttpOnly/i.test(rawCookie) && !vBody.includes(ticket) && !!noCookie.errors
      && wBody.data?.resetPassword?.success === true && /Expires=Thu, 01 Jan 1970/i.test(cleared)
      && await bcrypt.compare('ViaGraph88', u.password_hash!),
    detail: `cookie=${rawCookie.slice(0, 60)} noCookieErr=${!!noCookie.errors} cleared=${cleared.slice(0, 40)}`,
  };
});

// ── AU2: the refresh token never appears in a response body ────────────
test('AU2 POST /login: the body has no refreshToken (anywhere), the httpOnly refreshToken cookie is set', async (base) => {
  const email = addr('rest-login');
  await insertUser(email);
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PW }),
  });
  const text = await res.text();
  const body = JSON.parse(text) as { data?: Record<string, unknown> };
  const raw = (res.headers.getSetCookie?.() ?? []).find(c => c.startsWith('refreshToken=')) ?? '';
  const cookie = cookieValue(res, 'refreshToken') ?? '';
  return {
    pass: res.status === 200 && body.data?.status === 'AUTHENTICATED' && !!body.data?.accessToken
      && !('refreshToken' in (body.data ?? {})) && !/refreshToken/.test(text) && cookie.length > 20 && !text.includes(cookie)
      && /HttpOnly/i.test(raw),
    detail: `keys=${Object.keys(body.data ?? {}).join(',')} cookie=${raw.slice(0, 30)}…`,
  };
});

// ── AU3: a password change ends every other session, keeps the current one ──
test('AU3 updateProfile / updateAdminProfile password change: session A stays refreshable, session B gets 401', async () => {
  const run = async (change: (id: string, keep: string) => Promise<unknown>, role: string) => {
    const email = addr(`pw-change-${role}`);
    const id = await insertUser(email, { role });
    const a = await login(email);
    const b = await login(email);
    await change(id, a.refreshToken);
    const aRefresh = await errOf(Auth.refreshAccessToken(a.refreshToken));
    const bRefresh = await errOf(Auth.refreshAccessToken(b.refreshToken));
    return { ok: aRefresh === null && bRefresh instanceof AppError && bRefresh.statusCode === 401, detail: `${role}: A=${aRefresh?.message ?? 'ok'} B=${(bRefresh as AppError)?.statusCode}` };
  };
  const student = await run((id, keep) => Auth.updateProfile(id, { currentPassword: PW, newPassword: 'Changed123' }, keep), 'STUDENT');
  const admin = await run((id, keep) => updateAdminProfile(id, undefined, PW, 'Changed123', keep), 'ADMIN');
  // A name-only update ends nothing.
  const email = addr('name-only');
  const id = await insertUser(email);
  const a = await login(email); const b = await login(email);
  await Auth.updateProfile(id, { name: 'New Name' }, a.refreshToken);
  const untouched = (await errOf(Auth.refreshAccessToken(b.refreshToken))) === null;
  return { pass: student.ok && admin.ok && untouched, detail: `${student.detail} | ${admin.detail} | nameOnlyKeepsB=${untouched}` };
});

test('AU3 REST PATCH /auth/me with a new password: the calling browser keeps refreshing, the other browser is logged out', async (base) => {
  const email = addr('rest-pw');
  await insertUser(email);
  const loginRest = async () => {
    const r = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
    const body = await r.json() as { data: { accessToken: string } };
    return { access: body.data.accessToken, cookie: `refreshToken=${cookieValue(r, 'refreshToken')}` };
  };
  const a = await loginRest(); const b = await loginRest();
  const patch = await fetch(`${base}/api/v1/auth/me`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.access}`, Cookie: a.cookie },
    body: JSON.stringify({ currentPassword: PW, newPassword: 'RestChange9' }),
  });
  const refresh = (cookie: string) => fetch(`${base}/api/v1/auth/refresh-token`, { method: 'POST', headers: { Cookie: cookie } });
  const ra = await refresh(a.cookie); const rb = await refresh(b.cookie);
  return { pass: patch.status === 200 && ra.status === 200 && rb.status === 401, detail: `patch=${patch.status} A=${ra.status} B=${rb.status}` };
});

// ── AU4: signup takes as long for a taken address as for a fresh one ─────
// Timing-based: medians over 10 runs each must be within 50 ms. On a slow or
// noisy machine set AUTH_TIMING_TESTS=skip to skip it (it then reports PASS
// with "skipped" in the detail).
test('AU4 signup: a taken address is not measurably faster than a fresh one (median gap < 50 ms over 10 runs)', async () => {
  if (process.env.AUTH_TIMING_TESTS === 'skip') return { pass: true, detail: 'skipped (AUTH_TIMING_TESTS=skip)' };
  const taken = addr('signup-taken');
  await insertUser(taken);
  const time = async (email: string) => { const t = process.hrtime.bigint(); await Auth.signupUser('Timing User', email, PW); return Number(process.hrtime.bigint() - t) / 1e6; };
  await time(addr('signup-warmup'));
  const fresh: number[] = [], existing: number[] = [];
  for (let i = 0; i < 10; i++) { fresh.push(await time(addr('signup-fresh'))); existing.push(await time(taken)); }
  const med = (a: number[]) => { const x = [...a].sort((p, q) => p - q); return (x[4] + x[5]) / 2; };
  const gap = Math.abs(med(fresh) - med(existing));
  return { pass: gap < 50, detail: `fresh≈${med(fresh).toFixed(0)}ms taken≈${med(existing).toFixed(0)}ms gap=${gap.toFixed(0)}ms` };
});

// ── AU5: a Google-only admin changing a password gets a clear 400 ──────
test('AU5 updateAdminProfile on a Google-only admin (no password) → 400 with the Google sign-in message, not a 500', async () => {
  const id = await insertUser(addr('g-admin'), { role: 'ADMIN', password: null, googleId: `g-${Date.now()}-adm` });
  const e = await errOf(updateAdminProfile(id, undefined, 'Whatever1', 'NewPass123'));
  return {
    pass: e instanceof AppError && e.statusCode === 400 && e.message === 'This account uses Google sign-in and has no password to change.',
    detail: `${(e as AppError)?.statusCode} ${e?.message}`,
  };
});

// ── AU6: a dead refresh cookie is cleared (401 only, never on 409) ──────
test('AU6 POST /auth/refresh-token: a revoked token → 401 and the refreshToken cookie is cleared; a 409 (concurrent refresh) keeps it', async (base) => {
  const refresh = (token: string) => fetch(`${base}/api/v1/auth/refresh-token`, { method: 'POST', headers: { Cookie: `refreshToken=${token}` } });
  const clearing = (res: Response) => (res.headers.getSetCookie?.() ?? []).find(c => /^refreshToken=;/.test(c) && /Expires=Thu, 01 Jan 1970/i.test(c));
  const email = addr('dead-cookie');
  const id = await insertUser(email);
  const a = await login(email);
  await Auth.revokeAllSessions(id);
  const revoked = await refresh(a.refreshToken);
  const b = await login(email);
  const first = await refresh(b.refreshToken);           // rotates b
  const raced = await refresh(b.refreshToken);           // same token again inside the grace window → 409
  return {
    pass: revoked.status === 401 && !!clearing(revoked) && first.status === 200 && raced.status === 409 && !clearing(raced),
    detail: `revoked=${revoked.status} cleared=${!!clearing(revoked)} first=${first.status} raced=${raced.status} clearedOn409=${!!clearing(raced)}`,
  };
});

// ── AU7: lookups match the case-insensitive unique index ───────────────
test('AU7 a user stored as "Admin@…" logs in as "admin@…" (and " ADMIN@… "); migration 017 lowercases stored emails, twice safely', async () => {
  const stamp = `${Date.now()}-${++seq}`;
  const stored = `Admin-${stamp}@AUTH-HARDENING.test`;
  await query(`INSERT INTO users (name, email, password_hash, is_verified, role) VALUES ('Mixed Case', $1, $2, TRUE, 'ADMIN')`,
    [stored, await bcrypt.hash(PW, 4)]);
  const lower = await Auth.loginUser(stored.toLowerCase(), PW);
  const padded = await Auth.loginUser(`  ${stored.toUpperCase()}  `, PW);
  const sql = readFileSync(path.join(__dirname, '../db/migrations/017_users_email_lowercase.sql'), 'utf8');
  await pool.query(sql); await pool.query(sql);
  const after = (await query<{ email: string }>('SELECT email FROM users WHERE lower(email) = $1', [stored.toLowerCase()])).rows;
  return {
    pass: lower.status === 'AUTHENTICATED' && padded.status === 'AUTHENTICATED' && after.length === 1 && after[0].email === stored.toLowerCase(),
    detail: `lower=${lower.status} padded=${padded.status} stored-after=${after[0]?.email}`,
  };
});

// ── runner ───────────────────────────────────────────────────────────────
async function cleanup(): Promise<void> {
  await query(`DELETE FROM users WHERE email LIKE $1`, [`%${DOMAIN}`]);
}

async function main(): Promise<void> {
  await cleanup();
  const app = await createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('failed to bind ephemeral port');
  const base = `http://127.0.0.1:${a.port}`;

  let failures = 0;
  for (const c of cases) {
    try {
      const r = await c.run(base);
      if (r.pass) console.log(`PASS  ${c.label}${r.detail ? ` (${r.detail})` : ''}`);
      else { failures++; console.log(`FAIL  ${c.label}${r.detail ? ` (${r.detail})` : ''}`); }
    } catch (err) {
      failures++;
      console.log(`FAIL  ${c.label} (threw: ${(err as Error).message})`);
    }
  }

  await cleanup().catch(err => console.log(`cleanup failed: ${(err as Error).message}`));
  console.log(`\n${cases.length - failures}/${cases.length} passed`);
  server.closeAllConnections?.();
  server.close();
  await pool.end().catch(() => undefined);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
