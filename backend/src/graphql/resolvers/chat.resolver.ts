import { GraphQLError } from 'graphql';
import { GraphQLContext } from '../context';
import { AuthenticatedRequest, QnaChunk } from '../../types';
import {
  askLectureAgent,
  getChatHistory,
  getPaginatedChatHistory,
  searchChatHistory,
  clearChat,
  deleteChatEntry,
  renameChatEntry,
} from '../../services/chat.service';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';

function getStudent(ctx: GraphQLContext) {
  const user = (ctx.req as AuthenticatedRequest).user;
  if (!user) throw new GraphQLError('Unauthorized', { extensions: { code: 'UNAUTHENTICATED' } });
  return user;
}

function chunkToGql(c: QnaChunk) {
  return {
    id:        c.id,
    topic:     c.topic ?? null,
    question:  c.question,
    startTime: c.start_time ?? null,
    endTime:   c.end_time   ?? null,
  };
}

function wrap(fn: () => Promise<unknown>) {
  return fn().catch((err: unknown) => {
    if (err instanceof AppError) {
      throw new GraphQLError(err.message, { extensions: { code: 'BAD_REQUEST', status: err.statusCode } });
    }
    if (err instanceof GraphQLError) throw err;
    logger.error('[CHAT RESOLVER] Unexpected error', err);
    throw new GraphQLError('Something went wrong. Please try again.', {
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });
}

export const chatResolvers = {
  Query: {
    chatHistory: (
      _: unknown,
      { lectureId }: { lectureId: number },
      ctx: GraphQLContext
    ) =>
      wrap(async () => {
        const student = getStudent(ctx);
        const entries = await getChatHistory(student.id, lectureId);
        return entries.map(e => {
          // sources_detail is a JSON array injected by the SQL subquery in getChatHistory
          const detail = ((e as unknown as Record<string, unknown>).sources_detail ?? []) as Array<{
            id: number; topic: string | null; question: string; start_time: string | null; end_time: string | null;
          }>;
          return {
            id:        e.id,
            question:  e.question,
            answer:    e.answer,
            createdAt: e.created_at.toISOString(),
            sources:   detail.map(s => ({
              id:        s.id,
              topic:     s.topic     ?? null,
              question:  s.question,
              startTime: s.start_time ?? null,
              endTime:   s.end_time   ?? null,
            })),
          };
        });
      }),

    paginatedChatHistory: (
      _: unknown,
      { lectureId, limit, offset }: { lectureId: number; limit: number; offset: number },
      ctx: GraphQLContext
    ) =>
      wrap(async () => {
        const student = getStudent(ctx);
        const { entries, total } = await getPaginatedChatHistory(student.id, lectureId, limit, offset);
        const mapped = entries.map(e => {
          const detail = ((e as unknown as Record<string, unknown>).sources_detail ?? []) as Array<{
            id: number; topic: string | null; question: string; start_time: string | null; end_time: string | null;
          }>;
          return {
            id:        e.id,
            question:  e.question,
            answer:    e.answer,
            createdAt: e.created_at.toISOString(),
            sources:   detail.map(s => ({
              id:        s.id,
              topic:     s.topic     ?? null,
              question:  s.question,
              startTime: s.start_time ?? null,
              endTime:   s.end_time   ?? null,
            })),
          };
        });
        return { entries: mapped, total, hasMore: offset + limit < total };
      }),

    searchChatHistory: (
      _: unknown,
      { lectureId, query }: { lectureId: number; query: string },
      ctx: GraphQLContext
    ) =>
      wrap(async () => {
        const student = getStudent(ctx);
        const entries = await searchChatHistory(student.id, lectureId, query);
        return entries.map(e => {
          const detail = ((e as unknown as Record<string, unknown>).sources_detail ?? []) as Array<{
            id: number; topic: string | null; question: string; start_time: string | null; end_time: string | null;
          }>;
          return {
            id:        e.id,
            question:  e.question,
            answer:    e.answer,
            createdAt: e.created_at.toISOString(),
            sources:   detail.map(s => ({
              id:        s.id,
              topic:     s.topic     ?? null,
              question:  s.question,
              startTime: s.start_time ?? null,
              endTime:   s.end_time   ?? null,
            })),
          };
        });
      }),
  },

  Mutation: {
    askLectureAgent: (
      _: unknown,
      { input }: { input: { lectureId: number; question: string } },
      ctx: GraphQLContext
    ) =>
      wrap(async () => {
        const student = getStudent(ctx);
        if (!input.question.trim()) {
          throw new GraphQLError('Question cannot be empty', { extensions: { code: 'BAD_REQUEST' } });
        }
        logger.info(`[CHAT] Student "${student.email}" → lecture #${input.lectureId}: "${input.question.slice(0, 80)}"`);
        const { answer, sources } = await askLectureAgent({
          studentId: student.id,
          lectureId: input.lectureId,
          question:  input.question.trim(),
        });
        return { answer, sources: sources.map(chunkToGql) };
      }),

    clearChat: (
      _: unknown,
      { lectureId }: { lectureId: number },
      ctx: GraphQLContext
    ) =>
      wrap(async () => {
        const student = getStudent(ctx);
        await clearChat(student.id, lectureId);
        return { success: true, message: 'Chat cleared.' };
      }),

    deleteChatEntry: (
      _: unknown,
      { id }: { id: number },
      ctx: GraphQLContext
    ) =>
      wrap(async () => {
        const student = getStudent(ctx);
        return deleteChatEntry(student.id, id);
      }),

    renameChatEntry: (
      _: unknown,
      { id, label }: { id: number; label: string },
      ctx: GraphQLContext
    ) =>
      wrap(async () => {
        const student = getStudent(ctx);
        return renameChatEntry(student.id, id, label);
      }),
  },
};
