import { GraphQLError } from 'graphql';
import { GraphQLContext } from '../context';
import { AuthenticatedRequest } from '../../types';
import {
  getAnalyticsSummary,
  getQuestionsPerLecture,
  getRecentQuestions,
  getLectureStatusList,
  getRegisteredStudents,
} from '../../services/analytics.service';
import { logger } from '../../utils/logger';

function requireAdmin(ctx: GraphQLContext) {
  const user = (ctx.req as AuthenticatedRequest).user;
  if (!user) throw new GraphQLError('Unauthorized', { extensions: { code: 'UNAUTHENTICATED' } });
  if (user.role !== 'ADMIN') {
    logger.warn(`[ANALYTICS] Forbidden: ${user.role} "${user.email}" tried analytics`);
    throw new GraphQLError('Forbidden — admin only', { extensions: { code: 'FORBIDDEN' } });
  }
}

export const analyticsResolvers = {
  Query: {
    analyticsSummary: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      requireAdmin(ctx);
      return getAnalyticsSummary();
    },

    questionsPerLecture: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      requireAdmin(ctx);
      return getQuestionsPerLecture();
    },

    recentQuestions: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      requireAdmin(ctx);
      return getRecentQuestions();
    },

    lectureStatusList: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      requireAdmin(ctx);
      return getLectureStatusList();
    },

    registeredStudents: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      requireAdmin(ctx);
      return getRegisteredStudents();
    },
  },
};
