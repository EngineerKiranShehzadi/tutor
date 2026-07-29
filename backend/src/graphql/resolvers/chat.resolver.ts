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
  getChatSessions,
  getSessionHistory,
  createChatSession,
  deleteChatSession,
  renameChatSession,
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

// Shared mapper: DB row → GraphQL ChatHistoryEntry
function mapEntry(e: Record<string, unknown>) {
  const detail = (e.sources_detail ?? []) as Array<{
    id: number; topic: string | null; question: string; start_time: string | null; end_time: string | null;
  }>;
  return {
    id:           e.id as number,
    question:     e.question as string,
    answer:       e.answer as string,
    createdAt:    (e.created_at as Date).toISOString(),
    displayLabel: (e.display_label as string) ?? null,
    sources:      detail.map(s => ({
      id:        s.id,
      topic:     s.topic     ?? null,
      question:  s.question,
      startTime: s.start_time ?? null,
      endTime:   s.end_time   ?? null,
    })),
  };
}

export const chatResolvers = {
  Query: {
    // ── Session queries ──────────────────────────────────────
    chatSessions: (
      _: unknown,
      { lectureId }: { lectureId: number },
      ctx: GraphQLContext
    ) =>
      wrap(async () => {
        const student = getStudent(ctx);
        return getChatSessions(student.id, lectureId);
      }),

    sessionHistory: (
      _: unknown,
      { sessionId }: { sessionId: number },
      ctx: GraphQLContext
    ) =>
      wrap(async () => {
        const student = getStudent(ctx);
        const entries = await getSessionHistory(student.id, sessionId);
        return entries.map(e => mapEntry(e as unknown as Record<string, unknown>));
      }),

    // ── Legacy queries (kept for ChatDrawer / backward compat) ──
    chatHistory: (
      _: unknown,
      { lectureId }: { lectureId: number },
      ctx: GraphQLContext
    ) =>
      wrap(async () => {
        const student  = getStudent(ctx);
        const entries  = await getChatHistory(student.id, lectureId);
        return entries.map(e => mapEntry(e as unknown as Record<string, unknown>));
      }),

    paginatedChatHistory: (
      _: unknown,
      { lectureId, limit, offset }: { lectureId: number; limit: number; offset: number },
      ctx: GraphQLContext
    ) =>
      wrap(async () => {
        const student = getStudent(ctx);
        const { entries, total } = await getPaginatedChatHistory(student.id, lectureId, limit, offset);
        return {
          entries: entries.map(e => mapEntry(e as unknown as Record<string, unknown>)),
          total,
          hasMore: offset + limit < total,
        };
      }),

    searchChatHistory: (
      _: unknown,
      { lectureId, query }: { lectureId: number; query: string },
      ctx: GraphQLContext
    ) =>
      wrap(async () => {
        const student  = getStudent(ctx);
        const entries  = await searchChatHistory(student.id, lectureId, query);
        return entries.map(e => mapEntry(e as unknown as Record<string, unknown>));
      }),
  },

  Mutation: {
    // ── Session mutations ─────────────────────────────────────
    createChatSession: (
      _: unknown,
      { lectureId }: { lectureId: number },
      ctx: GraphQLContext
    ) =>
      wrap(async () => {
        const student = getStudent(ctx);
        return createChatSession(student.id, lectureId);
      }),

    deleteChatSession: (
      _: unknown,
      { id }: { id: number },
      ctx: GraphQLContext
    ) =>
      wrap(async () => {
        const student = getStudent(ctx);
        return deleteChatSession(student.id, id);
      }),

    renameChatSession: (
      _: unknown,
      { id, title }: { id: number; title: string },
      ctx: GraphQLContext
    ) =>
      wrap(async () => {
        const student = getStudent(ctx);
        return renameChatSession(student.id, id, title);
      }),

    // ── Core AI mutation ──────────────────────────────────────
    askLectureAgent: (
      _: unknown,
      { input }: { input: { lectureId: number; question: string; sessionId: number } },
      ctx: GraphQLContext
    ) =>
      wrap(async () => {
        const student = getStudent(ctx);
        if (!input.question.trim()) {
          throw new GraphQLError('Question cannot be empty', { extensions: { code: 'BAD_REQUEST' } });
        }
        logger.info(`[CHAT] "${student.email}" → session #${input.sessionId}: "${input.question.slice(0, 80)}"`);
        const { answer, sources } = await askLectureAgent({
          studentId: student.id,
          lectureId: input.lectureId,
          question:  input.question.trim(),
          sessionId: input.sessionId,
        });
        return { answer, sources: sources.map(chunkToGql) };
      }),

    // ── Legacy mutations ──────────────────────────────────────
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
