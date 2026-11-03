import { GraphQLError } from 'graphql';
import { GraphQLContext } from '../context';
import { AuthenticatedRequest } from '../../types';
import { getMyNotifications, markNotificationsRead } from '../../services/notification.service';
import { logger } from '../../utils/logger';

/**
 * Notifications for the signed-in student.
 *
 * The user id always comes from the verified token, never from an argument, so
 * there is no way to read or mark someone else's notifications.
 */

const requireUser = (ctx: GraphQLContext) => {
  const user = (ctx.req as AuthenticatedRequest).user;
  if (!user) throw new GraphQLError('Unauthorized', { extensions: { code: 'UNAUTHENTICATED' } });
  return user;
};

export const notificationResolvers = {
  Query: {
    myNotifications: (
      _: unknown,
      args: { limit?: number | null; offset?: number | null },
      ctx: GraphQLContext
    ) => {
      const user = requireUser(ctx);
      logger.info(`[GRAPHQL] myNotifications(limit=${args.limit ?? 'default'}, offset=${args.offset ?? 0}) by "${user.email}"`);
      return getMyNotifications(user.id, args);
    },
  },

  Mutation: {
    markNotificationsRead: async (
      _: unknown,
      args: { ids?: number[] | null },
      ctx: GraphQLContext
    ) => {
      const user = requireUser(ctx);
      const updated = await markNotificationsRead(user.id, args.ids);
      logger.info(`[GRAPHQL] markNotificationsRead -> ${updated} by "${user.email}"`);
      // The fresh list, so the bell does not need a second round trip to show
      // the new unread count.
      return getMyNotifications(user.id, { limit: 10, offset: 0 });
    },
  },
};
