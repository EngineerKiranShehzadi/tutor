import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { Express } from 'express';
import { typeDefs } from './typeDefs';
import { resolvers as authResolvers } from './resolvers/auth.resolver';
import { chatResolvers } from './resolvers/chat.resolver';
import { lectureResolvers } from './resolvers/lecture.resolver';
import { analyticsResolvers } from './resolvers/analytics.resolver';
import { GraphQLContext } from './context';
import { verifyAccessToken } from '../utils/jwt';
import { query } from '../config/database';
import { AuthenticatedRequest } from '../types';
import { logger } from '../utils/logger';

const mergedResolvers = {
  Query: {
    ...authResolvers.Query,
    ...lectureResolvers.Query,
    ...chatResolvers.Query,
    ...analyticsResolvers.Query,
  },
  Mutation: {
    ...authResolvers.Mutation,
    ...lectureResolvers.Mutation,
    ...chatResolvers.Mutation,
  },
};

export const setupApollo = async (app: Express): Promise<void> => {
  const server = new ApolloServer<GraphQLContext>({
    typeDefs,
    resolvers: mergedResolvers,
    formatError: (err, originalError) => {
      const cause = (originalError as Error)?.message ?? err.message;
      logger.error(`[GRAPHQL] ❌ ${err.message} | cause: ${cause}`, { extensions: err.extensions });
      return err;
    },
  });

  await server.start();
  logger.info('[GRAPHQL] ✅ Apollo Server started at /graphql');

  app.use(
    '/graphql',
    expressMiddleware(server, {
      context: async ({ req, res }) => {
        // Parse Bearer token and attach user to req so resolvers can read req.user
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
          try {
            const token = authHeader.split(' ')[1];
            const payload = verifyAccessToken(token);
            const { rows } = await query<{ id: string; name: string; email: string; role: string }>(
              'SELECT id, name, email, role FROM users WHERE id = $1',
              [payload.userId]
            );
            if (rows[0]) {
              (req as AuthenticatedRequest).user = rows[0] as AuthenticatedRequest['user'];
              logger.info(`[GRAPHQL] 🔐 Authenticated: ${rows[0].email} (${rows[0].role})`);
            }
          } catch {
            // Invalid / expired token — req.user stays undefined
            // Resolvers that require auth will throw UNAUTHENTICATED
          }
        }
        return { req, res };
      },
    })
  );
};
