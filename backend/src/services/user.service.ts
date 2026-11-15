import { query } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { comparePassword, hashPassword } from '../utils/password';
import { validatePassword } from '../utils/password-policy';
import { sendPasswordChangedEmail } from './email.service';
import { logger } from '../utils/logger';
import { notifyRoleGranted } from './admin-invite.service';
import { revokeOtherSessions } from './auth.service';
import { pageArgs, likePattern } from '../utils/paging';

// One page of users (both roles), with server-side search over name/e-mail and
// an optional role filter — never the whole table of e-mail addresses (AD6).
// The summary counts cover every user.
/**
 * The orders this list can be read in, written out in full.
 *
 * The client sends a name from this list, never a column: a sort argument
 * that reaches the query as text is how an ORDER BY becomes an injection
 * point. An unknown name falls back to newest first.
 */
const SORTS: Record<string, string> = {
  JOINED_DESC: 'created_at DESC, id',
  JOINED_ASC:  'created_at ASC, id',
};

export const getAllUsers = async (
  f: { limit?: number | null; offset?: number | null; search?: string | null;
       role?: string | null; sort?: string | null } = {}
) => {
  const { limit, offset, search } = pageArgs(f);
  const orderBy = SORTS[f.sort ?? ''] ?? SORTS.JOINED_DESC;
  const where: string[] = [];
  const params: unknown[] = [];
  if (search) {
    params.push(likePattern(search));
    where.push(`(name ILIKE $${params.length} OR email ILIKE $${params.length})`);
  }
  if (f.role === 'STUDENT' || f.role === 'ADMIN') {
    params.push(f.role);
    where.push(`role = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [{ rows }, { rows: cnt }, { rows: summary }] = await Promise.all([
    query<{ id: string; name: string; email: string; role: string; is_verified: boolean; created_at: Date }>(
      `SELECT id, name, email, role, is_verified, created_at FROM users ${whereSql}
       ORDER BY ${orderBy}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    query<{ n: string }>(`SELECT COUNT(*) AS n FROM users ${whereSql}`, params),
    query<{ total: string; students: string; admins: string }>(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE role = 'STUDENT') AS students, COUNT(*) FILTER (WHERE role = 'ADMIN') AS admins FROM users`
    ),
  ]);
  const total = Number(cnt[0]?.n ?? 0);
  logger.info(`[USER] allUsers: ${rows.length} of ${total} (offset ${offset}${search ? ', search' : ''}${f.role ? `, ${f.role}` : ''})`);
  return {
    items: rows.map(r => ({
      id:         r.id,
      name:       r.name,
      email:      r.email,
      role:       r.role,
      isVerified: r.is_verified,
      createdAt:  r.created_at.toISOString(),
    })),
    total,
    hasMore: offset + rows.length < total,
    totalUsers:   Number(summary[0]?.total ?? 0),
    studentCount: Number(summary[0]?.students ?? 0),
    adminCount:   Number(summary[0]?.admins ?? 0),
  };
};

/**
 * Refuse a change that would leave the system with no administrator.
 *
 * "You cannot do it to yourself" is not enough on its own. Two admins can
 * remove each other, and if both requests are in flight at the same moment
 * each one sees the other still in place and both succeed, leaving nobody who
 * can administer anything. Locking the admin rows makes the second request
 * wait for the first and then see the truth.
 */
const assertNotLastAdmin = async (targetId: string, action: string) => {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM users WHERE role = 'ADMIN' FOR UPDATE`);
  const others = rows.filter(r => r.id !== targetId);
  if (rows.some(r => r.id === targetId) && others.length === 0) {
    throw new AppError(
      `This is the only administrator. Give someone else the admin role before you ${action} this account.`, 400);
  }
};

export const deleteUser = async (id: string, requestingAdminId: string) => {
  if (id === requestingAdminId) throw new AppError('Cannot delete your own account', 400);
  const { rows } = await query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [id]);
  if (!rows[0]) throw new AppError('User not found', 404);
  if (rows[0].role === 'ADMIN') await assertNotLastAdmin(id, 'delete');
  await query(`DELETE FROM users WHERE id = $1`, [id]);
  logger.info(`[USER] ✅ Deleted user id=${id}`);
  return true;
};

export const updateUserRole = async (id: string, role: string, requestingAdminId: string) => {
  if (!['STUDENT', 'ADMIN'].includes(role)) throw new AppError('Invalid role', 400);
  if (id === requestingAdminId && role !== 'ADMIN') throw new AppError('Cannot demote yourself', 400);
  const { rows: before } = await query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [id]);
  if (role !== 'ADMIN' && before[0]?.role === 'ADMIN') await assertNotLastAdmin(id, 'remove the admin role from');
  const { rows } = await query<{
    id: string; name: string; email: string; role: string; is_verified: boolean; created_at: Date;
  }>(
    `UPDATE users SET role = $1 WHERE id = $2
     RETURNING id, name, email, role, is_verified, created_at`,
    [role, id]
  );
  if (!rows[0]) throw new AppError('User not found', 404);
  const r = rows[0];
  // End the user's sessions so the change cannot be outlived by a refresh token
  // minted under the old role. (Access tokens are fine: every request re-reads
  // the role from the database.)
  const changed = before[0]?.role !== role;
  if (changed) await query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [id]);
  // Gaining admin access is security-relevant and the person may not be
  // looking at the app, so it is sent to them rather than left to be noticed.
  if (changed && role === 'ADMIN') {
    await notifyRoleGranted(r.id, r.name, r.email, requestingAdminId);
  }
  logger.info(`[USER] ✅ Role updated: user id=${id} → ${role}${changed ? ' (sessions revoked)' : ' (unchanged)'}`);
  return { id: r.id, name: r.name, email: r.email, role: r.role, isVerified: r.is_verified, createdAt: r.created_at.toISOString() };
};

export const updateAdminProfile = async (
  adminId: string,
  name?: string,
  currentPassword?: string,
  newPassword?: string,
  // The caller's refresh cookie: a password change ends every other session.
  currentRefreshToken?: string
) => {
  const { rows } = await query<{ id: string; name: string; email: string; role: string; password_hash: string | null }>(
    `SELECT id, name, email, role, password_hash FROM users WHERE id = $1`,
    [adminId]
  );
  const admin = rows[0];
  if (!admin) throw new AppError('Admin not found', 404);

  if (newPassword) {
    if (!currentPassword) throw new AppError('Current password required to set a new password', 400);
    // The same password back again is not a password change; it ends every
    // other session for no benefit and reads as a success that did nothing.
    if (currentPassword === newPassword) {
      throw new AppError('The new password must be different from the current one', 400);
    }
    // A Google-only account has no hash; comparing against NULL threw
    // "Illegal arguments" and surfaced as a 500 (updateProfile already did this).
    if (!admin.password_hash) throw new AppError('This account uses Google sign-in and has no password to change.', 400);
    validatePassword(newPassword, 'New password');
    const valid = await comparePassword(currentPassword, admin.password_hash);
    if (!valid) throw new AppError('Current password is incorrect', 401);
    const hash = await hashPassword(newPassword);
    await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, adminId]);
    await revokeOtherSessions(adminId, currentRefreshToken);
    logger.info(`[USER] ✅ Password changed for admin id=${adminId}; other sessions ended`);
    // Told, not just done. A password change the account holder did not make
    // is the one event they need to hear about, and the only way they hear
    // about it is this message. A failure here must not undo the change.
    try {
      await sendPasswordChangedEmail(admin.email, admin.name);
    } catch (err) {
      logger.error(`[USER] password change notice failed for ${admin.email}`, err);
    }
  }

  if (name !== undefined) {
    // An empty name was silently ignored and the caller was told the profile
    // had been updated. Either it is a real name or it is an error.
    const trimmed = name.trim();
    if (trimmed.length < 2)   throw new AppError('Name must be at least 2 characters', 400);
    if (trimmed.length > 100) throw new AppError('Name must be 100 characters or fewer', 400);
    await query(`UPDATE users SET name = $1 WHERE id = $2`, [trimmed, adminId]);
    logger.info(`[USER] ✅ Name updated for admin id=${adminId}`);
  }

  const { rows: updated } = await query<{ id: string; name: string; email: string; role: string }>(
    `SELECT id, name, email, role FROM users WHERE id = $1`,
    [adminId]
  );
  return updated[0];
};
