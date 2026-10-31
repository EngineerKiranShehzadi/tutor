import { query } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { comparePassword, hashPassword } from '../utils/password';
import { validatePassword } from '../utils/password-policy';
import { logger } from '../utils/logger';
import { revokeOtherSessions } from './auth.service';
import { pageArgs, likePattern } from '../utils/paging';

// One page of users (both roles), with server-side search over name/e-mail and
// an optional role filter — never the whole table of e-mail addresses (AD6).
// The summary counts cover every user.
export const getAllUsers = async (
  f: { limit?: number | null; offset?: number | null; search?: string | null; role?: string | null } = {}
) => {
  const { limit, offset, search } = pageArgs(f);
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
       ORDER BY created_at DESC, id
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

export const deleteUser = async (id: string, requestingAdminId: string) => {
  if (id === requestingAdminId) throw new AppError('Cannot delete your own account', 400);
  const { rows } = await query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [id]);
  if (!rows[0]) throw new AppError('User not found', 404);
  await query(`DELETE FROM users WHERE id = $1`, [id]);
  logger.info(`[USER] ✅ Deleted user id=${id}`);
  return true;
};

export const updateUserRole = async (id: string, role: string, requestingAdminId: string) => {
  if (!['STUDENT', 'ADMIN'].includes(role)) throw new AppError('Invalid role', 400);
  if (id === requestingAdminId && role !== 'ADMIN') throw new AppError('Cannot demote yourself', 400);
  const { rows: before } = await query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [id]);
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
  const { rows } = await query<{ id: string; name: string; email: string; role: string; password_hash: string }>(
    `SELECT id, name, email, role, password_hash FROM users WHERE id = $1`,
    [adminId]
  );
  const admin = rows[0];
  if (!admin) throw new AppError('Admin not found', 404);

  if (newPassword) {
    if (!currentPassword) throw new AppError('Current password required to set a new password', 400);
    validatePassword(newPassword, 'New password');
    const valid = await comparePassword(currentPassword, admin.password_hash);
    if (!valid) throw new AppError('Current password is incorrect', 401);
    const hash = await hashPassword(newPassword);
    await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, adminId]);
    await revokeOtherSessions(adminId, currentRefreshToken);
    logger.info(`[USER] ✅ Password changed for admin id=${adminId}; other sessions ended`);
  }

  if (name && name.trim()) {
    await query(`UPDATE users SET name = $1 WHERE id = $2`, [name.trim(), adminId]);
    logger.info(`[USER] ✅ Name updated for admin id=${adminId}`);
  }

  const { rows: updated } = await query<{ id: string; name: string; email: string; role: string }>(
    `SELECT id, name, email, role FROM users WHERE id = $1`,
    [adminId]
  );
  return updated[0];
};
