// Shared paging for admin lists (recentQuestionsPage, lectureChunks,
// registeredStudents, allUsers, studentJourney): an integer clamped into
// range, and LIKE patterns whose wildcards in the search text match literally.

export const clampInt = (v: unknown, def: number, min: number, max: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : def;
  return Math.min(max, Math.max(min, n));
};

export const likePattern = (search: string): string => `%${search.replace(/[\\%_]/g, '\\$&')}%`;

// Admin lists that carry student data or full answers are served a page at a
// time: at most ADMIN_PAGE_MAX rows.
export const ADMIN_PAGE_MAX = 100;
export const ADMIN_PAGE_DEFAULT = 25;

export const pageArgs = (f: { limit?: number | null; offset?: number | null; search?: string | null }) => ({
  limit:  clampInt(f.limit, ADMIN_PAGE_DEFAULT, 1, ADMIN_PAGE_MAX),
  offset: clampInt(f.offset, 0, 0, Number.MAX_SAFE_INTEGER),
  search: (f.search ?? '').trim().slice(0, 200),
});
