import { GraphQLError } from 'graphql';
import { GraphQLContext } from '../context';
import { AuthenticatedRequest } from '../../types';
import {
  getAnalyticsSummary,
  getQuestionsPerLecture,
  getRecentQuestions,
  getRecentQuestionsPage,
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

    recentQuestions: (_: unknown, { limit }: { limit?: number | null }, ctx: GraphQLContext) => {
      requireAdmin(ctx);
      const user = (ctx.req as AuthenticatedRequest).user;
      logger.info(`[GRAPHQL] recentQuestions(limit=${limit ?? 'default'}) query by admin "${user?.email}"`);
      return getRecentQuestions(limit);
    },

    recentQuestionsPage: (
      _: unknown,
      args: { limit: number; offset: number; search?: string | null; lectureId?: number | null },
      ctx: GraphQLContext
    ) => {
      requireAdmin(ctx);
      const user = (ctx.req as AuthenticatedRequest).user;
      logger.info(`[GRAPHQL] recentQuestionsPage(limit=${args.limit}, offset=${args.offset}) query by admin "${user?.email}"`);
      return getRecentQuestionsPage(args);
    },

    lectureStatusList: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      requireAdmin(ctx);
      const user = (ctx.req as AuthenticatedRequest).user;
      logger.info(`[GRAPHQL] lectureStatusList query by admin "${user?.email}"`);
      return getLectureStatusList();
    },

    registeredStudents: (
      _: unknown,
      args: { limit?: number | null; offset?: number | null; search?: string | null; status?: string | null },
      ctx: GraphQLContext
    ) => {
      requireAdmin(ctx);
      const user = (ctx.req as AuthenticatedRequest).user;
      logger.info(`[GRAPHQL] registeredStudents(limit=${args.limit}, offset=${args.offset}) query by admin "${user?.email}"`);
      return getRegisteredStudents(args);
    },

    lectureChunks: (
      _: unknown,
      { lectureId, ...page }: { lectureId: number; limit?: number | null; offset?: number | null; search?: string | null },
      ctx: GraphQLContext
    ) => {
      requireAdmin(ctx);
      const user = (ctx.req as AuthenticatedRequest).user;
      logger.info(`[GRAPHQL] lectureChunks query for lecture #${lectureId} (limit=${page.limit}, offset=${page.offset}) by admin "${user?.email}"`);
      return getLectureChunks(lectureId, page);
    },

    lectureAgentDetails: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      requireAdmin(ctx);
      const user = (ctx.req as AuthenticatedRequest).user;
      logger.info(`[GRAPHQL] lectureAgentDetails query by admin "${user?.email}"`);
      return getLectureAgentDetails();
    },

    studentJourney: (
      _: unknown,
      { id, ...page }: { id: string; limit?: number | null; offset?: number | null },
      ctx: GraphQLContext
    ) => {
      requireAdmin(ctx);
      const user = (ctx.req as AuthenticatedRequest).user;
      logger.info(`[GRAPHQL] studentJourney for student #${id} by admin "${user?.email}"`);
      return getStudentJourney(id, page);
    },

    contentGaps: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      requireAdmin(ctx);
      const user = (ctx.req as AuthenticatedRequest).user;
      logger.info(`[GRAPHQL] contentGaps query by admin "${user?.email}"`);
      return getContentGaps();
    },
  },
};
