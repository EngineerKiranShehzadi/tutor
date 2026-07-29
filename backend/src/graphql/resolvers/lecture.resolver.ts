import { GraphQLError } from 'graphql';
import { GraphQLContext } from '../context';
import {
  createLecture,
  getLectures,
  getLectureById,
  updateLecture,
  deleteLecture,
} from '../../services/lecture.service';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';

function requireAdmin(ctx: GraphQLContext) {
  const user = (ctx.req as import('../../types').AuthenticatedRequest).user;
  if (!user) throw new GraphQLError('Unauthorized', { extensions: { code: 'UNAUTHENTICATED', status: 401 } });
  if (user.role !== 'ADMIN') {
    logger.warn(`[GRAPHQL] Forbidden: ${user.role} "${user.email}" tried admin operation`);
    throw new GraphQLError('Forbidden — admin only', { extensions: { code: 'FORBIDDEN', status: 403 } });
  }
  return user;
}

function requireAuth(ctx: GraphQLContext) {
  const user = (ctx.req as import('../../types').AuthenticatedRequest).user;
  if (!user) throw new GraphQLError('Unauthorized', { extensions: { code: 'UNAUTHENTICATED', status: 401 } });
  return user;
}

function toGql(lecture: import('../../types').Lecture) {
  return {
    id: String(lecture.id),
    title: lecture.title,
    description: lecture.description ?? null,
    youtubeUrl: lecture.youtube_url,
    youtubeVideoId: lecture.youtube_video_id ?? null,
    status: lecture.status,
    progressCurrent: lecture.progress_current ?? 0,
    progressTotal: lecture.progress_total ?? 0,
    createdAt: lecture.created_at.toISOString(),
    updatedAt: lecture.updated_at.toISOString(),
  };
}

function wrap(fn: () => Promise<unknown>) {
  return fn().catch((err: unknown) => {
    if (err instanceof AppError) {
      throw new GraphQLError(err.message, { extensions: { code: 'BAD_REQUEST', status: err.statusCode } });
    }
    throw err;
  });
}

export const lectureResolvers = {
  Query: {
    lectures: (_: unknown, __: unknown, ctx: GraphQLContext) =>
      wrap(async () => {
        const user = requireAuth(ctx);
        logger.info(`[GRAPHQL] lectures query by "${user.email}" (${user.role})`);
        const list = await getLectures();
        logger.info(`[GRAPHQL] ✅ lectures: returned ${list.length} lecture(s) to "${user.email}"`);
        return list.map(toGql);
      }),

    lecture: (_: unknown, { id }: { id: string }, ctx: GraphQLContext) =>
      wrap(async () => {
        const user = requireAuth(ctx);
        logger.info(`[GRAPHQL] lecture #${id} query by "${user.email}"`);
        const l = await getLectureById(Number(id));
        return toGql(l);
      }),
  },

  Mutation: {
    createLecture: (
      _: unknown,
      { input }: { input: { title: string; description?: string; youtubeUrl: string } },
      ctx: GraphQLContext
    ) =>
      wrap(async () => {
        const admin = requireAdmin(ctx);
        logger.info(`[GRAPHQL] createLecture: admin "${admin.email}" → title="${input.title}"`);
        const l = await createLecture(input);
        logger.info(`[GRAPHQL] ✅ createLecture: lecture #${l.id} "${l.title}" created by "${admin.email}"`);
        return toGql(l);
      }),

    updateLecture: (
      _: unknown,
      { id, input }: { id: string; input: { title?: string; description?: string; youtubeUrl?: string } },
      ctx: GraphQLContext
    ) =>
      wrap(async () => {
        const admin = requireAdmin(ctx);
        logger.info(`[GRAPHQL] updateLecture: admin "${admin.email}" → lecture #${id}`);
        const l = await updateLecture(Number(id), input);
        logger.info(`[GRAPHQL] ✅ updateLecture: lecture #${id} updated by "${admin.email}"`);
        return toGql(l);
      }),

    deleteLecture: (_: unknown, { id }: { id: string }, ctx: GraphQLContext) =>
      wrap(async () => {
        const admin = requireAdmin(ctx);
        logger.info(`[GRAPHQL] deleteLecture: admin "${admin.email}" → lecture #${id}`);
        const result = await deleteLecture(Number(id));
        logger.info(`[GRAPHQL] ✅ deleteLecture: lecture #${id} deleted by "${admin.email}"`);
        return result;
      }),
  },
};
