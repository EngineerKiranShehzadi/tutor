'use client';
import { useRouter } from 'next/navigation';
import { useQuery } from '@apollo/client';
import { GET_LECTURES } from '@/graphql/lecture.queries';
import { DBLecture } from '@/types';

const STATUS_BADGE: Record<string, { label: string; color: string }> = {
  READY:            { label: 'AI Ready',     color: 'bg-green-100 text-green-700' },
  PROCESSING:       { label: 'Processing',   color: 'bg-blue-100 text-blue-700' },
  EMBEDDING:        { label: 'Embedding',    color: 'bg-purple-100 text-purple-700' },
  DATASET_UPLOADED: { label: 'Uploaded',     color: 'bg-yellow-100 text-yellow-700' },
  NO_DATASET:       { label: 'No Dataset',   color: 'bg-gray-100 text-gray-500' },
  FAILED:           { label: 'Failed',       color: 'bg-red-100 text-red-700' },
};

// The lectures table has no explicit ordering column and the server returns
// rows in insertion order, which put Lecture 6 first, so the order is taken
// from the lecture number in the title. The real titles are not uniform, and
// both exceptions are handled here rather than by renaming anyone's data:
//   "Lecture 2| ...", "Lecture 6 — ..."      -> 2, 6
//   "Lecture -1 Introduction to ..."         -> 1  (a dash before the number)
//   "Introductory Lecture - Introduction ..." -> 0  (no number; it precedes 1)
// Anything still unrecognised sorts last instead of breaking the list.
const lectureNumber = (title: string): number => {
  const t = title ?? '';
  if (/introductor/i.test(t)) return 0;
  const m = /lecture\s*[-–—#:]?\s*0*(\d+)/i.exec(t);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
};

export default function CoursesPage() {
  const router = useRouter();
  const { data, loading, error } = useQuery(GET_LECTURES);

  const lectures: DBLecture[] = data?.lectures ?? [];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    console.error('[COURSES] ❌ Failed to load lectures:', error.message);
    return (
      <div className="flex items-center justify-center h-64 text-red-600">
        <i className="fas fa-exclamation-circle mr-2" />
        Failed to load lectures. Please try again.
      </div>
    );
  }

  // Apollo's result array is frozen: copy before sorting.
  const ordered = [...lectures].sort((a, b) => {
    const d = lectureNumber(a.title) - lectureNumber(b.title);
    return d !== 0 ? d : (a.title ?? '').localeCompare(b.title ?? '');
  });

  const firstReady = ordered.find((l) => l.status === 'READY');
  // The player used to point at a playlist address written into this file.
  // It now shows the first lecture that has a video, straight from the
  // database, so a lecture added or removed by an admin is reflected here
  // with no code change.
  const featured = ordered.find((l) => l.youtubeVideoId);

  return (
    <div className="px-6 py-8">
      <div className="flex gap-5 items-start">

      {/* LEFT — Featured lecture video (from the database) */}
      <div className="w-[55%] shrink-0">
        <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-black shadow-md">
          {featured?.youtubeVideoId ? (
            <iframe
              src={`https://www.youtube.com/embed/${featured.youtubeVideoId}?rel=0&modestbranding=1`}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              className="w-full h-full border-0"
              title={featured.title}
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center text-white/60 gap-2">
              <i className="fas fa-video-slash text-3xl" />
              <p className="text-sm">No video available yet</p>
            </div>
          )}
        </div>
        {featured && (
          <p className="mt-3 text-[15px] font-semibold text-[var(--text)] leading-snug">
            {featured.title}
          </p>
        )}
      </div>

      {/* RIGHT — Lecture list */}
      <div className="flex-1 min-w-0 bg-white rounded-xl border border-[var(--border)] shadow-md flex flex-col overflow-hidden">

        {/* Header */}
        <div className="px-4 py-4 border-b border-[var(--border)]">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-[21px] font-bold text-[var(--text)]">Course Lectures</h1>
              <p className="text-[14px] text-[var(--muted)] mt-0.5">
                {ordered.length} lecture{ordered.length !== 1 ? 's' : ''} available
              </p>
            </div>
            {firstReady && (
              <button
                onClick={() => router.push(`/lecture/${firstReady.id}`)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--text)] text-white rounded-full text-[13px] font-bold hover:bg-gray-800 transition-colors shrink-0"
              >
                <i className="fas fa-play text-[8px]" /> Start Learning
              </button>
            )}
          </div>
        </div>

        {/* List — no height cap: all lectures are visible instead of being cut off */}
        <div>
          {ordered.length === 0 ? (
            <div className="text-center py-16 text-[var(--muted)]">
              <i className="fas fa-video-slash text-3xl mb-3 block" />
              <p className="text-sm font-semibold">No lectures yet</p>
              <p className="text-xs mt-1">Check back soon.</p>
            </div>
          ) : (
            ordered.map((lec) => {
              const badge   = STATUS_BADGE[lec.status] ?? STATUS_BADGE.NO_DATASET;
              const isReady = lec.status === 'READY';
              return (
                <div
                  key={lec.id}
                  onClick={() => isReady && router.push(`/lecture/${lec.id}`)}
                  className={`flex gap-3 px-4 py-3 border-b border-[var(--border)] transition-colors ${
                    isReady ? 'cursor-pointer hover:bg-[var(--surface)]' : 'opacity-60 cursor-default'
                  }`}
                >
                  {/* Thumbnail */}
                  {lec.youtubeVideoId ? (
                    <div className="w-[100px] shrink-0 aspect-video rounded-md overflow-hidden bg-black">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`https://i.ytimg.com/vi/${lec.youtubeVideoId}/hqdefault.jpg`}
                        alt={lec.title}
                        className="w-full h-full object-cover"
                      />
                    </div>
                  ) : (
                    <div className="w-[100px] shrink-0 aspect-video rounded-md bg-[var(--surface)] flex items-center justify-center">
                      <i className="fas fa-play-circle text-lg text-[var(--muted)]" />
                    </div>
                  )}

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-[15px] font-semibold leading-snug line-clamp-2 mb-1.5 text-[var(--text)]">
                      {lec.title}
                    </p>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[12px] font-bold ${badge.color}`}>
                      <i className={`fas ${isReady ? 'fa-robot' : 'fa-clock'} text-[8px]`} />
                      {badge.label}
                    </span>
                  </div>

                  {isReady && (
                    <i className="fas fa-chevron-right text-[var(--muted)] text-[11px] shrink-0 self-center" />
                  )}
                </div>
              );
            })
          )}
        </div>

      </div>

      </div>
    </div>
  );
}
