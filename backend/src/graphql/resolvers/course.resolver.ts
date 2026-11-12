import { GraphQLError } from 'graphql';
import { GraphQLContext } from '../context';
import { AuthenticatedRequest } from '../../types';
import { AppError } from '../../middleware/errorHandler';
import {
  listCourses, getCourse, createCourse, updateCourse,
  archiveCourse, restoreCourse, deleteCourse, Course,
} from '../../services/course.service';

function authorize(ctx: GraphQLContext, adminOnly = false): void {
  const user = (ctx.req as AuthenticatedRequest).user;
  if (!user) throw new GraphQLError('Unauthorized', {extensions: {code: 'UNAUTHENTICATED'}});
  if (adminOnly && user.role !== 'ADMIN') throw new GraphQLError('Forbidden', {extensions: {code: 'FORBIDDEN'}});
}
function isAdmin(ctx: GraphQLContext): boolean {
  return (ctx.req as AuthenticatedRequest).user?.role === 'ADMIN';
}
async function wrap(fn: () => Promise<unknown>): Promise<unknown> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, {extensions: {code: 'BAD_REQUEST', status: e.statusCode}});
    }
    throw e;
  }
}
const toGql = (c: Course) => ({
  id: String(c.id), title: c.title, subtitle: c.subtitle, description: c.description,
  lectureCount: c.lecture_count, readyCount: c.ready_count,
  createdAt: c.created_at.toISOString(), updatedAt: c.updated_at.toISOString(),
  archivedAt: c.archived_at ? c.archived_at.toISOString() : null,
});
export const courseResolvers = {
  Query: {
    // includeArchived is honoured for admins only: a student asking for it
    // would otherwise be able to list courses that have been withdrawn.
    courses: (_: unknown, {includeArchived}: {includeArchived?: boolean}, ctx: GraphQLContext) => wrap(async () => {
      authorize(ctx);
      return (await listCourses(includeArchived === true && isAdmin(ctx))).map(toGql);
    }),
    course: (_: unknown, {id}: {id: string}, ctx: GraphQLContext) => wrap(async () => {
      authorize(ctx); return toGql(await getCourse(Number(id)));
    }),
  },
  Mutation: {
    createCourse: (_: unknown, {input}: {input: {title: string; subtitle?: string; description?: string}}, ctx: GraphQLContext) => wrap(async () => {
      authorize(ctx, true); return toGql(await createCourse(input));
    }),
    updateCourse: (_: unknown, {id, input}: {id: string; input: {title?: string; subtitle?: string; description?: string}}, ctx: GraphQLContext) => wrap(async () => {
      authorize(ctx, true); return toGql(await updateCourse(Number(id), input));
    }),
    archiveCourse: (_: unknown, {id}: {id: string}, ctx: GraphQLContext) => wrap(async () => {
      authorize(ctx, true); return toGql(await archiveCourse(Number(id)));
    }),
    restoreCourse: (_: unknown, {id}: {id: string}, ctx: GraphQLContext) => wrap(async () => {
      authorize(ctx, true); return toGql(await restoreCourse(Number(id)));
    }),
    deleteCourse: (_: unknown, {id}: {id: string}, ctx: GraphQLContext) => wrap(async () => {
      authorize(ctx, true); await deleteCourse(Number(id)); return true;
    }),
  },
};
