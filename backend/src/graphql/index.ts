import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { Express } from 'express';
import { GraphQLError, type GraphQLFormattedError } from 'graphql';
import { unwrapResolverError } from '@apollo/server/errors';
import { AppError, describeError } from '../middleware/errorHandler';
import { logSafeText } from '../observability/sanitize';
import { typeDefs } from './typeDefs';
import { resolvers as authResolvers } from './resolvers/auth.resolver';
import { chatResolvers } from './resolvers/chat.resolver';
import { lectureResolvers } from './resolvers/lecture.resolver';
import { analyticsResolvers } from './resolvers/analytics.resolver';
import { userResolvers } from './resolvers/user.resolver';
import { GraphQLContext } from './context';
import { verifyAccessToken } from '../utils/jwt';
import { query } from '../config/database';
import { AuthenticatedRequest } from '../types';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { queryLimitsRule } from './query-limits';

const mergedResolvers = {
  Query: {
    ...authResolvers.Query,
    ...lectureResolvers.Query,
    ...chatResolvers.Query,
    ...analyticsResolvers.Query,
    ...userResolvers.Query,
  },
  Mutation: {
    ...authResolvers.Mutation,
    ...lectureResolvers.Mutation,
    ...chatResolvers.Mutation,
    ...userResolvers.Mutation,
  },
};

// Logs every GraphQL error without its raw text (A18): error messages can
// quote variable values — i.e. a student's question — so the log gets the code
// and a content-safe form (logSafeText / describeError). The client keeps
// GraphQL's own messages and the app's intended AppError messages; anything
// else that escaped a resolver is replaced by a generic message.
export function formatGraphQLError(err: GraphQLFormattedError, originalError: unknown): GraphQLFormattedError {
  const code = String(err.extensions?.code ?? 'UNKNOWN');
  const cause = unwrapResolverError(originalError);
  const unexpected = !(cause instanceof GraphQLError) && !(cause instanceof AppError) && code === 'INTERNAL_SERVER_ERROR';
  const d = describeError(cause ?? err);
  const log = unexpected ? logger.error.bind(logger) : logger.warn.bind(logger);
  log(`[GRAPHQL] ${code} path=${err.path?.join('.') ?? '-'} message=${logSafeText(err.message, 120)} cause: ${d.line}`, d.details ?? {});
  if (!unexpected) return err;
  const { stacktrace: _drop, ...extensions } = (err.extensions ?? {}) as Record<string, unknown>;
  return { ...err, message: 'Internal server error', extensions };
}

export const setupApollo = async (app: Express): Promise<void> => {
  const server = new ApolloServer<GraphQLContext>({
    typeDefs,
    resolvers: mergedResolvers,
    // Apollo Server 4 leaves introspection on regardless of NODE_ENV; the
    // schema is not published in production (GRAPHQL_INTROSPECTION overrides).
    introspection: env.GRAPHQL.INTROSPECTION,
    validationRules: [queryLimitsRule({ maxDepth: env.GRAPHQL.MAX_DEPTH, maxFields: env.GRAPHQL.MAX_FIELDS })],
    formatError: (err, originalError) => formatGraphQLError(err, originalError),
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
