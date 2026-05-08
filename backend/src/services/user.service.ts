import { query } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { comparePassword, hashPassword } from '../utils/password';
import { logger } from '../utils/logger';

export const getAllUsers = async () => {
  logger.info('[USER] getAllUsers: fetching all users');
  const { rows } = await query<{
    id: string; name: string; email: string; role: string; is_verified: boolean; created_at: Date;
  }>(`SELECT id, name, email, role, is_verified, created_at FROM users ORDER BY created_at DESC`);
  return rows.map(r => ({
    id:         r.id,
    name:       r.name,
    email:      r.email,
    role:       r.role,
    isVerified: r.is_verified,
    createdAt:  r.created_at.toISOString(),
  }));
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
  const { rows } = await query<{
    id: string; name: string; email: string; role: string; is_verified: boolean; created_at: Date;
  }>(
    `UPDATE users SET role = $1 WHERE id = $2
     RETURNING id, name, email, role, is_verified, created_at`,
    [role, id]
  );
  if (!rows[0]) throw new AppError('User not found', 404);
  const r = rows[0];
  logger.info(`[USER] ✅ Role updated: user id=${id} → ${role}`);
  return { id: r.id, name: r.name, email: r.email, role: r.role, isVerified: r.is_verified, createdAt: r.created_at.toISOString() };
};

export const updateAdminProfile = async (
  adminId: string,
  name?: string,
  currentPassword?: string,
  newPassword?: string
) => {
  const { rows } = await query<{ id: string; name: string; email: string; role: string; password_hash: string }>(
    `SELECT id, name, email, role, password_hash FROM users WHERE id = $1`,
    [adminId]
  );
  const admin = rows[0];
  if (!admin) throw new AppError('Admin not found', 404);

  if (newPassword) {
    if (!currentPassword) throw new AppError('Current password required to set a new password', 400);
    const valid = await comparePassword(currentPassword, admin.password_hash);
    if (!valid) throw new AppError('Current password is incorrect', 401);
    const hash = await hashPassword(newPassword);
    await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, adminId]);
    logger.info(`[USER] ✅ Password changed for admin id=${adminId}`);
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
