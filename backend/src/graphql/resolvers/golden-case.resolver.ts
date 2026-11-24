import { GraphQLError } from 'graphql';
import type { GraphQLContext } from '../context';
import type { AuthenticatedRequest } from '../../types';
import { AppError } from '../../middleware/errorHandler';
import {
  generateDraftCases, listGoldenCases, reviewGoldenCase, exportApprovedGold, createGoldenCase,
} from '../../services/golden-case.service';

function admin(ctx: GraphQLContext): string {
  const user = (ctx.req as AuthenticatedRequest).user;
  if (!user) throw new GraphQLError('Unauthorized', { extensions: { code: 'UNAUTHENTICATED' } });
  if (user.role !== 'ADMIN') throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
  return user.id;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.statusCode === 404 ? 'NOT_FOUND' : e.statusCode === 409 ? 'CONFLICT' : 'BAD_REQUEST', status: e.statusCode } });
    }
    throw e;
  }
}

export const goldenCaseResolvers = {
  Query: {
    goldenBenchmarkCases: (_: unknown, a: { datasetVersionId: number; status?: string; limit?: number }, ctx: GraphQLContext) =>
      guarded(async () => { admin(ctx); return listGoldenCases(a.datasetVersionId, a.status, a.limit); }),
    goldenGoldJson: (_: unknown, a: { datasetVersionId: number }, ctx: GraphQLContext) =>
      guarded(async () => { admin(ctx); return JSON.stringify(await exportApprovedGold(a.datasetVersionId), null, 2); }),
  },
  Mutation: {
    generateGoldenDraftCases: (_: unknown, a: { lectureId: number; datasetVersionId: number }, ctx: GraphQLContext) =>
      guarded(async () => { admin(ctx); return generateDraftCases(a.lectureId, a.datasetVersionId); }),
    reviewGoldenCase: (_: unknown, a: { id: number; status: string; question?: string; category?: string; answerable?: boolean; expectedChunkIds?: number[] }, ctx: GraphQLContext) =>
      guarded(() => reviewGoldenCase(admin(ctx), a.id, {
        status: a.status, question: a.question, category: a.category,
        answerable: a.answerable, expectedChunkIds: a.expectedChunkIds,
      })),
    createGoldenCase: (_: unknown, a: { lectureId: number; datasetVersionId: number; question: string; category: string; answerable: boolean; expectedChunkIds?: number[] | null; expectedAnswer?: string | null }, ctx: GraphQLContext) =>
      guarded(() => createGoldenCase(admin(ctx), {
        lectureId: a.lectureId, datasetVersionId: a.datasetVersionId, question: a.question,
        category: a.category, answerable: a.answerable,
        expectedChunkIds: a.expectedChunkIds ?? [], expectedAnswer: a.expectedAnswer,
      })),
  },
};
