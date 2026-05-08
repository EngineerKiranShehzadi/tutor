import { GraphQLError } from 'graphql';
import { GraphQLContext } from '../context';
import { AuthenticatedRequest } from '../../types';
import { AppError } from '../../middleware/errorHandler';
import { getAllUsers, deleteUser, updateUserRole, updateAdminProfile } from '../../services/user.service';
import { logger } from '../../utils/logger';

function requireAdmin(ctx: GraphQLContext) {
  const user = (ctx.req as AuthenticatedRequest).user;
  if (!user) throw new GraphQLError('Unauthorized', { extensions: { code: 'UNAUTHENTICATED' } });
  if (user.role !== 'ADMIN') throw new GraphQLError('Forbidden — admin only', { extensions: { code: 'FORBIDDEN' } });
  return user;
}

function wrap(fn: () => Promise<unknown>) {
  return fn().catch((err: unknown) => {
    if (err instanceof AppError)
      throw new GraphQLError(err.message, { extensions: { code: 'BAD_REQUEST', status: err.statusCode } });
    throw err;
  });
}

export const userResolvers = {
  Query: {
    allUsers: (_: unknown, __: unknown, ctx: GraphQLContext) =>
      wrap(async () => {
        const admin = requireAdmin(ctx);
        logger.info(`[GRAPHQL] allUsers query by admin "${admin.email}"`);
        return getAllUsers();
      }),
  },

  Mutation: {
    deleteUser: (_: unknown, { id }: { id: string }, ctx: GraphQLContext) =>
      wrap(async () => {
        const admin = requireAdmin(ctx);
        logger.info(`[GRAPHQL] deleteUser: admin "${admin.email}" → user id=${id}`);
        return deleteUser(id, admin.id);
      }),

    updateUserRole: (_: unknown, { id, role }: { id: string; role: string }, ctx: GraphQLContext) =>
      wrap(async () => {
        const admin = requireAdmin(ctx);
        logger.info(`[GRAPHQL] updateUserRole: admin "${admin.email}" → user id=${id} role=${role}`);
        return updateUserRole(id, role, admin.id);
      }),

    updateAdminProfile: (
      _: unknown,
      { name, currentPassword, newPassword }: { name?: string; currentPassword?: string; newPassword?: string },
      ctx: GraphQLContext
    ) =>
      wrap(async () => {
        const admin = requireAdmin(ctx);
        logger.info(`[GRAPHQL] updateAdminProfile: admin "${admin.email}"`);
        return updateAdminProfile(admin.id, name, currentPassword, newPassword);
      }),
  },
};
