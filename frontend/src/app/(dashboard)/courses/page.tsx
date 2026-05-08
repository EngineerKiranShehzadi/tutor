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

  const firstReady = lectures.find((l) => l.status === 'READY');

  return (
    <div className="px-4 py-5">
      <div className="flex gap-5 items-start">

      {/* LEFT — Playlist embed */}
      <div className="w-[55%] shrink-0">
        <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-black shadow-md">
          <iframe
            src="https://www.youtube.com/embed/videoseries?list=PL4kipppqKObLmh-ZpCqp8iXj1V2guWyhj&rel=0&modestbranding=1"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            className="w-full h-full border-0"
            title="Course Playlist"
          />
        </div>
      </div>

      {/* RIGHT — Lecture list */}
      <div className="flex-1 min-w-0 bg-white rounded-xl border border-[var(--border)] shadow-md flex flex-col overflow-hidden">

        {/* Header */}
        <div className="px-4 py-4 border-b border-[var(--border)]">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-[18px] font-bold text-[var(--text)]">Course Lectures</h1>
              <p className="text-[13px] text-[var(--muted)] mt-0.5">
                {lectures.length} lecture{lectures.length !== 1 ? 's' : ''} available
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

        {/* List */}
        <div className="overflow-y-auto" style={{ maxHeight: '340px' }}>
          {lectures.length === 0 ? (
            <div className="text-center py-16 text-[var(--muted)]">
              <i className="fas fa-video-slash text-3xl mb-3 block" />
              <p className="text-sm font-semibold">No lectures yet</p>
              <p className="text-xs mt-1">Check back soon.</p>
            </div>
          ) : (
            lectures.map((lec, i) => {
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
                  {/* Number */}
                  <span className="w-5 text-[13px] font-bold text-[var(--muted)] shrink-0 mt-1 text-center">
                    {i + 1}
                  </span>

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
                    <p className="text-[14px] font-semibold leading-snug line-clamp-2 mb-1.5 text-[var(--text)]">
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
