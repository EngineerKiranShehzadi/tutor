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
        requireAuth(ctx);
        const list = await getLectures();
        return list.map(toGql);
      }),

    lecture: (_: unknown, { id }: { id: string }, ctx: GraphQLContext) =>
      wrap(async () => {
        requireAuth(ctx);
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
        requireAdmin(ctx);
        const l = await createLecture(input);
        return toGql(l);
      }),

    updateLecture: (
      _: unknown,
      { id, input }: { id: string; input: { title?: string; description?: string; youtubeUrl?: string } },
      ctx: GraphQLContext
    ) =>
      wrap(async () => {
        requireAdmin(ctx);
        const l = await updateLecture(Number(id), input);
        return toGql(l);
      }),

    deleteLecture: (_: unknown, { id }: { id: string }, ctx: GraphQLContext) =>
      wrap(async () => {
        requireAdmin(ctx);
        return deleteLecture(Number(id));
      }),
  },
};
