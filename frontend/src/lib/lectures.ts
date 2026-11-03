/**
 * Lecture ordering and readiness — the single source for both.
 *
 * These rules lived only in the courses page. The lecture page had its own
 * wording ("🟢 AI Ready" / "⏳ Preparing") and no ordering at all, so the same
 * lecture was labelled two different ways and the sidebar list opened with
 * Lecture 6 at the top. Anything that shows a lecture now reads from here.
 */

/**
 * Position of a lecture in the course, taken from its title.
 *
 * The lectures table has no ordering column and the server returns rows in
 * insertion order, which is not course order. The real titles are not uniform,
 * so both exceptions are handled here rather than by renaming anyone's data:
 *
 *   "Lecture 2| …", "Lecture 6 — …"          -> 2, 6
 *   "Lecture -1 Introduction to …"           -> 1   (a dash before the number)
 *   "Introductory Lecture - Introduction …"  -> 0   (no number; precedes 1)
 *
 * Anything unrecognised sorts last instead of breaking the list.
 *
 * This is a workaround, not a design. The proper fix is an integer `position`
 * column on `lectures` that the admin sets when adding one; until that exists
 * a lecture titled without a number will always fall to the end.
 */
export const lectureNumber = (title: string): number => {
  const t = title ?? '';
  if (/introductor/i.test(t)) return 0;
  const m = /lecture\s*[-–—#:]?\s*0*(\d+)/i.exec(t);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
};

/**
 * Course order, oldest lesson first — the order a student would work through,
 * and the order the playlist is published in.
 *
 * Returns a new array: Apollo freezes its result arrays, so sorting one in
 * place throws.
 */
export const sortLectures = <T extends { title: string }>(list: readonly T[]): T[] =>
  [...list].sort((a, b) => {
    const d = lectureNumber(a.title) - lectureNumber(b.title);
    return d !== 0 ? d : (a.title ?? '').localeCompare(b.title ?? '');
  });

/** A lecture can only be asked about once its dataset is embedded and active. */
export const isLectureReady = (status?: string | null): boolean => status === 'READY';

export const STATUS_BADGE: Record<string, { label: string; color: string }> = {
  // Ready uses the brand colour because it is the state that matters; the rest
  // are neutral or a warning, so they never compete with it.
  READY:            { label: 'Tutor ready', color: 'bg-[var(--accent-soft)] text-[var(--accent)]' },
  PROCESSING:       { label: 'Processing',  color: 'bg-[var(--surface)] text-[var(--muted)]' },
  EMBEDDING:        { label: 'Embedding',   color: 'bg-[var(--surface)] text-[var(--muted)]' },
  DATASET_UPLOADED: { label: 'Uploaded',    color: 'bg-[var(--gold-soft)] text-[var(--gold)]' },
  NO_DATASET:       { label: 'No material', color: 'bg-[var(--surface)] text-[var(--muted2)]' },
  FAILED:           { label: 'Failed',      color: 'bg-red-50 text-red-700' },
};

export const statusBadge = (status?: string | null) =>
  STATUS_BADGE[status ?? ''] ?? STATUS_BADGE.NO_DATASET;

/**
 * What to tell a student about a lecture whose tutor is not ready.
 *
 * The page used to print the raw column value — "status: NO_DATASET" — which
 * means nothing to a student and reads as an error. These say what is actually
 * true of each state in ordinary words.
 */
export const notReadyMessage = (status?: string | null): string => {
  switch (status) {
    case 'PROCESSING':
    case 'EMBEDDING':
      return 'The tutor for this lecture is being prepared right now. It will be ready shortly.';
    case 'DATASET_UPLOADED':
      return 'The lecture material has been uploaded. The tutor is about to be built from it.';
    case 'FAILED':
      return 'The tutor for this lecture could not be built. Your instructor has been notified.';
    default:
      return 'No material has been added for this lecture yet, so the tutor cannot answer questions about it. You can still watch the video.';
  }
};
