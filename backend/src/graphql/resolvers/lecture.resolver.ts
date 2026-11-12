import { GraphQLError } from 'graphql';
import { GraphQLContext } from '../context';
import {
  createLecture,
  getLectures,
  getLectureById,
  updateLecture,
  deleteLecture,
  archiveLecture,
  restoreLecture,
  lectureQuestionCount,
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
    courseId: String(lecture.course_id),
    agentName: lecture.agent_name ?? null,
    description: lecture.description ?? null,
    youtubeUrl: lecture.youtube_url,
    youtubeVideoId: lecture.youtube_video_id ?? null,
    status: lecture.status,
    archivedAt: lecture.archived_at ? lecture.archived_at.toISOString() : null,
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
    // includeArchived is honoured for admins only: a student asking for it
    // would otherwise list lectures that have been withdrawn.
    lectures: (_: unknown, args: { courseId?: number; includeArchived?: boolean }, ctx: GraphQLContext) =>
      wrap(async () => {
        const user = requireAuth(ctx);
        logger.info(`[GRAPHQL] lectures query by "${user.email}" (${user.role})`);
        const list = await getLectures(args.courseId, args.includeArchived === true && user.role === 'ADMIN');
        logger.info(`[GRAPHQL] ✅ lectures: returned ${list.length} lecture(s) to "${user.email}"`);
        return list.map(toGql);
      }),

    lectureQuestionCount: (_: unknown, { id }: { id: string }, ctx: GraphQLContext) =>
      wrap(async () => {
        requireAdmin(ctx);
        return lectureQuestionCount(Number(id));
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
      { input }: { input: { title: string; description?: string; youtubeUrl: string; agentName: string; agentInstructions: string; courseId?: number } },
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
      { id, input }: { id: string; input: { title?: string; description?: string; youtubeUrl?: string; courseId?: number } },
      ctx: GraphQLContext
    ) =>
      wrap(async () => {
        const admin = requireAdmin(ctx);
        logger.info(`[GRAPHQL] updateLecture: admin "${admin.email}" → lecture #${id}`);
        const l = await updateLecture(Number(id), input);
        logger.info(`[GRAPHQL] ✅ updateLecture: lecture #${id} updated by "${admin.email}"`);
        return toGql(l);
      }),

    archiveLecture: (_: unknown, { id }: { id: string }, ctx: GraphQLContext) =>
      wrap(async () => {
        const admin = requireAdmin(ctx);
        logger.info(`[GRAPHQL] archiveLecture: admin "${admin.email}" → lecture #${id}`);
        return toGql(await archiveLecture(Number(id)));
      }),

    restoreLecture: (_: unknown, { id }: { id: string }, ctx: GraphQLContext) =>
      wrap(async () => {
        const admin = requireAdmin(ctx);
        logger.info(`[GRAPHQL] restoreLecture: admin "${admin.email}" → lecture #${id}`);
        return toGql(await restoreLecture(Number(id)));
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
