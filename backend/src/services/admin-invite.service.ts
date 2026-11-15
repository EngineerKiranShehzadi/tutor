import { query } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { sendAdminInviteEmail, sendAdminRoleGrantedEmail } from './email.service';

/**
 * Inviting someone to administer the course.
 *
 * Two cases, and the difference is only whether the person already has an
 * account:
 *
 *   They do    → their role is changed now and they are told, by email and in
 *                the bell. Nothing is left pending, because there is nothing
 *                to wait for.
 *   They do not → the address is recorded and emailed. The role is applied the
 *                moment they finish signing up, by `claimAdminInvite`.
 *
 * An invitation is never a way around signing up: the person still registers
 * and verifies their email themselves. It only decides what they are when
 * they arrive.
 */

export const INVITE_VALID_DAYS = 14;

const normalise = (email: string) => email.trim().toLowerCase();

export interface AdminInvitation {
  id: number;
  email: string;
  invitedByName: string | null;
  createdAt: string;
  expiresAt: string;
  status: 'PENDING' | 'EXPIRED';
}

/** Give someone the admin role, and tell them it happened. */
export const grantAdminRole = async (userId: string, byAdminId: string) => {
  const { rows } = await query<{ name: string; email: string }>(
    `UPDATE users SET role = 'ADMIN' WHERE id = $1 RETURNING name, email`, [userId]);
  if (!rows[0]) throw new AppError('User not found', 404);
  // Sessions minted under the old role are ended, as they are for any role
  // change: a refresh token must not outlive the role it was issued under.
  await query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [userId]);
  const emailed = await notifyRoleGranted(userId, rows[0].name, rows[0].email, byAdminId);
  return { ...rows[0], emailed };
};

/**
 * Both channels, and neither of them may break the thing that triggered it.
 * Being made an admin is a security-relevant change to someone's account, so
 * they are told even if they are not looking at the app.
 */
export const notifyRoleGranted = async (
  userId: string, name: string, email: string, byAdminId: string | null,
): Promise<boolean> => {
  const { rows } = await query<{ name: string }>(
    `SELECT name FROM users WHERE id = $1`, [byAdminId]);
  const byName = rows[0]?.name ?? 'An administrator';
  try {
    await query(
      `INSERT INTO notifications (user_id, type, title, body, lecture_id)
       VALUES ($1, 'ADMIN_ROLE_GRANTED', $2, $3, NULL)`,
      [userId, 'You are now an administrator',
       `${byName} gave you the admin role. You can now manage courses, lectures and students.`]);
  } catch (err) {
    logger.error(`[INVITE] in-app notice failed for user ${userId}`, err);
  }
  try {
    await sendAdminRoleGrantedEmail(email, name, byName);
    return true;
  } catch (err) {
    // The role change stands either way, but the screen must not claim an
    // email was sent when it was not.
    logger.error(`[INVITE] grant email failed for ${email}`, err);
    return false;
  }
};

/**
 * Invite an address. Returns what happened so the screen can say it, rather
 * than reporting "invited" for a person who was promoted on the spot.
 */
export const inviteAdmin = async (rawEmail: string, byAdminId: string) => {
  const email = normalise(rawEmail);
  // Deliberately loose: the address only has to be routable enough to send to,
  // and a stricter pattern rejects valid addresses more often than it catches
  // typos.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError('Enter a valid email address.', 400);

  const { rows: existing } = await query<{ id: string; name: string; role: string }>(
    `SELECT id, name, role FROM users WHERE email = $1`, [email]);

  if (existing[0]) {
    if (existing[0].role === 'ADMIN') {
      throw new AppError(`${existing[0].name} is already an administrator.`, 400);
    }
    const granted = await grantAdminRole(existing[0].id, byAdminId);
    logger.info(`[INVITE] ${email} already had an account; role granted directly`);
    return { outcome: 'GRANTED' as const, email, name: existing[0].name, emailed: granted.emailed };
  }

  const { rows: inv } = await query<{ id: number }>(
    `INSERT INTO admin_invitations (email, invited_by, expires_at)
     VALUES ($1, $2, NOW() + make_interval(days => $3))
     ON CONFLICT (email) WHERE accepted_at IS NULL
       DO UPDATE SET invited_by = EXCLUDED.invited_by,
                     created_at = NOW(),
                     expires_at = EXCLUDED.expires_at
     RETURNING id`,
    [email, byAdminId, INVITE_VALID_DAYS]);

  const { rows: by } = await query<{ name: string }>(`SELECT name FROM users WHERE id = $1`, [byAdminId]);
  let emailed = false;
  try {
    await sendAdminInviteEmail(email, by[0]?.name ?? 'An administrator', INVITE_VALID_DAYS);
    emailed = true;
  } catch (err) {
    // The invitation stands whether or not the mail got out; it is claimed by
    // signing up with that address, not by clicking anything in the message.
    // But the screen is told, so it does not promise a message that never left.
    logger.error(`[INVITE] invite email failed for ${email}`, err);
  }
  logger.info(`[INVITE] ${email} invited (id=${inv[0]?.id}, emailed=${emailed})`);
  return { outcome: 'INVITED' as const, email, name: null, emailed };
};

/** Invitations that have not been taken up, newest first. */
export const listAdminInvitations = async (): Promise<AdminInvitation[]> => {
  const { rows } = await query<{
    id: number; email: string; invited_by_name: string | null;
    created_at: Date; expires_at: Date; expired: boolean;
  }>(
    `SELECT i.id, i.email, u.name AS invited_by_name, i.created_at, i.expires_at,
            (i.expires_at < NOW()) AS expired
       FROM admin_invitations i
       LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.accepted_at IS NULL
      ORDER BY i.created_at DESC
      LIMIT 100`);
  return rows.map(r => ({
    id: r.id,
    email: r.email,
    invitedByName: r.invited_by_name,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    status: r.expired ? 'EXPIRED' : 'PENDING',
  }));
};

export const revokeAdminInvitation = async (id: number) => {
  const { rowCount } = await query(
    `DELETE FROM admin_invitations WHERE id = $1 AND accepted_at IS NULL`, [id]);
  if (!rowCount) throw new AppError('That invitation has already been used or withdrawn.', 404);
  logger.info(`[INVITE] invitation #${id} withdrawn`);
  return true;
};

/**
 * Called once, immediately after an account is created, with the address it
 * was created under. If that address was invited and the invitation is still
 * live, the new account is an admin from its first login.
 *
 * Never throws: an invitation that cannot be applied must not stop someone
 * signing up. The worst case is a new student who an admin promotes by hand.
 */
export const claimAdminInvite = async (userId: string, rawEmail: string): Promise<boolean> => {
  try {
    const email = normalise(rawEmail);
    const { rows } = await query<{ id: number; invited_by: string | null }>(
      `UPDATE admin_invitations
          SET accepted_at = NOW(), accepted_by = $1
        WHERE email = $2 AND accepted_at IS NULL AND expires_at > NOW()
        RETURNING id, invited_by`,
      [userId, email]);
    if (!rows[0]) return false;

    const { rows: u } = await query<{ name: string; email: string }>(
      `UPDATE users SET role = 'ADMIN' WHERE id = $1 RETURNING name, email`, [userId]);
    if (!u[0]) return false;
    logger.info(`[INVITE] ${email} signed up and claimed invitation #${rows[0].id}`);
    await notifyRoleGranted(userId, u[0].name, u[0].email, rows[0].invited_by);
    return true;
  } catch (err) {
    logger.error(`[INVITE] claim failed for user ${userId}`, err);
    return false;
  }
};
