import { GraphQLError } from 'graphql';
import { GraphQLContext } from '../context';
import { AuthenticatedRequest } from '../../types';
import {
  getAnalyticsSummary,
  getQuestionsPerLecture,
  getRecentQuestions,
  getLectureStatusList,
  getRegisteredStudents,
  getLectureChunks,
  getLectureAgentDetails,
  getStudentJourney,
  getContentGaps,
  getMyStats,
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
    myStats: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      const user = (ctx.req as AuthenticatedRequest).user;
      if (!user) throw new GraphQLError('Unauthorized', { extensions: { code: 'UNAUTHENTICATED' } });
      logger.info(`[GRAPHQL] myStats query by "${user.email}"`);
      return getMyStats(user.id);
    },

    analyticsSummary: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      requireAdmin(ctx);
      const user = (ctx.req as AuthenticatedRequest).user;
      logger.info(`[GRAPHQL] analyticsSummary query by admin "${user?.email}"`);
      return getAnalyticsSummary();
    },

    questionsPerLecture: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      requireAdmin(ctx);
      const user = (ctx.req as AuthenticatedRequest).user;
      logger.info(`[GRAPHQL] questionsPerLecture query by admin "${user?.email}"`);
      return getQuestionsPerLecture();
    },

    recentQuestions: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      requireAdmin(ctx);
      const user = (ctx.req as AuthenticatedRequest).user;
      logger.info(`[GRAPHQL] recentQuestions query by admin "${user?.email}"`);
      return getRecentQuestions();
    },

    lectureStatusList: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      requireAdmin(ctx);
      const user = (ctx.req as AuthenticatedRequest).user;
      logger.info(`[GRAPHQL] lectureStatusList query by admin "${user?.email}"`);
      return getLectureStatusList();
    },

    registeredStudents: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      requireAdmin(ctx);
      const user = (ctx.req as AuthenticatedRequest).user;
      logger.info(`[GRAPHQL] registeredStudents query by admin "${user?.email}"`);
      return getRegisteredStudents();
    },

    lectureChunks: (_: unknown, { lectureId }: { lectureId: number }, ctx: GraphQLContext) => {
      requireAdmin(ctx);
      const user = (ctx.req as AuthenticatedRequest).user;
      logger.info(`[GRAPHQL] lectureChunks query for lecture #${lectureId} by admin "${user?.email}"`);
      return getLectureChunks(lectureId);
    },

    lectureAgentDetails: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      requireAdmin(ctx);
      const user = (ctx.req as AuthenticatedRequest).user;
      logger.info(`[GRAPHQL] lectureAgentDetails query by admin "${user?.email}"`);
      return getLectureAgentDetails();
    },

    studentJourney: (_: unknown, { id }: { id: string }, ctx: GraphQLContext) => {
      requireAdmin(ctx);
      const user = (ctx.req as AuthenticatedRequest).user;
      logger.info(`[GRAPHQL] studentJourney for student #${id} by admin "${user?.email}"`);
      return getStudentJourney(id);
    },

    contentGaps: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      requireAdmin(ctx);
      const user = (ctx.req as AuthenticatedRequest).user;
      logger.info(`[GRAPHQL] contentGaps query by admin "${user?.email}"`);
      return getContentGaps();
    },
  },
};
