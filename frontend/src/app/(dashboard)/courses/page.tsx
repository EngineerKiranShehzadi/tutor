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
    <div className="max-w-[1200px] mx-auto px-6 py-6">
      {/* Playlist embed */}
      <div className="w-full aspect-video rounded-xl overflow-hidden bg-black shadow-lg mb-6">
        <iframe
          src="https://www.youtube.com/embed/videoseries?list=PL4kipppqKObLmh-ZpCqp8iXj1V2guWyhj&rel=0&modestbranding=1"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          className="w-full h-full border-0"
          title="Course Playlist"
        />
      </div>

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text)]">Course Lectures</h1>
          <p className="text-sm text-[var(--muted)] mt-1">
            {lectures.length} lecture{lectures.length !== 1 ? 's' : ''} available
          </p>
        </div>
        {firstReady && (
          <button
            onClick={() => router.push(`/lecture/${firstReady.id}`)}
            className="flex items-center gap-2 px-4 py-2.5 bg-[var(--text)] text-white rounded-full text-sm font-bold hover:bg-gray-800 transition-colors"
          >
            <i className="fas fa-play text-xs" /> Start Learning
          </button>
        )}
      </div>

      {lectures.length === 0 ? (
        <div className="text-center py-16 text-[var(--muted)]">
          <i className="fas fa-video-slash text-4xl mb-4 block" />
          <p className="text-lg font-semibold">No lectures yet</p>
          <p className="text-sm mt-1">Check back soon — lectures will appear here once added by your instructor.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {lectures.map((lec, i) => {
            const badge = STATUS_BADGE[lec.status] ?? STATUS_BADGE.NO_DATASET;
            const isReady = lec.status === 'READY';

            return (
              <div
                key={lec.id}
                onClick={() => isReady && router.push(`/lecture/${lec.id}`)}
                className={`flex gap-4 p-4 rounded-xl border border-[var(--border)] bg-white transition-colors ${
                  isReady ? 'cursor-pointer hover:bg-[var(--surface)]' : 'opacity-70 cursor-default'
                }`}
              >
                {/* Number */}
                <div className="w-8 h-8 rounded-full bg-[var(--surface)] flex items-center justify-center text-sm font-bold text-[var(--muted)] shrink-0 mt-0.5">
                  {i + 1}
                </div>

                {/* Thumbnail */}
                {lec.youtubeVideoId ? (
                  <div className="relative w-36 shrink-0 aspect-video rounded-lg overflow-hidden bg-black">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`https://i.ytimg.com/vi/${lec.youtubeVideoId}/hqdefault.jpg`}
                      alt={lec.title}
                      className="w-full h-full object-cover"
                    />
                  </div>
                ) : (
                  <div className="w-36 shrink-0 aspect-video rounded-lg bg-[var(--surface)] flex items-center justify-center">
                    <i className="fas fa-play-circle text-2xl text-[var(--muted)]" />
                  </div>
                )}

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="text-[15px] font-semibold leading-snug line-clamp-2 mb-1">{lec.title}</p>
                  {lec.description && (
                    <p className="text-[12px] text-[var(--muted)] line-clamp-2 mb-2">{lec.description}</p>
                  )}
                  <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold ${badge.color}`}>
                    <i className={`fas ${isReady ? 'fa-robot' : 'fa-clock'} text-[9px]`} />
                    {badge.label}
                  </span>
                </div>

                {isReady && (
                  <div className="flex items-center shrink-0">
                    <i className="fas fa-chevron-right text-[var(--muted)] text-sm" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
