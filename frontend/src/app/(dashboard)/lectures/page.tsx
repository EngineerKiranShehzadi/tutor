'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { GET_COURSES } from '@/graphql/course.queries';
import { DBCourse } from '@/types/course';
import { useQuery } from '@apollo/client';
import { GET_LECTURES } from '@/graphql/lecture.queries';
import { DBLecture } from '@/types';
// Ordering and readiness come from one shared file so this page and the
// lecture page can never disagree about either again.
import { sortLectures, statusBadge, isLectureReady } from '@/lib/lectures';

export default function CoursesPage() {
  const router = useRouter();
  const { data, loading, error } = useQuery(GET_LECTURES);
  const { data: courseData } = useQuery(GET_COURSES);
  const [filterId, setFilterId] = useState<string | null>(null);
  useEffect(() => {
    setFilterId(new URLSearchParams(window.location.search).get('courseId'));
  }, []);

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

  const selectedCourse: DBCourse | undefined = (courseData?.courses ?? []).find((c: DBCourse) => c.id === filterId);
  const ordered = sortLectures(filterId ? lectures.filter(l => l.courseId === filterId) : lectures);

  const firstReady = ordered.find((l) => isLectureReady(l.status));
  // The player used to point at a playlist address written into this file.
  // It now shows the first lecture that has a video, straight from the
  // database, so a lecture added or removed by an admin is reflected here
  // with no code change.
  const featured = ordered.find((l) => l.youtubeVideoId);

  return (
    <div className="px-6 py-8">
      {selectedCourse && <p className="mb-4 text-label text-[var(--muted)]"><button onClick={() => router.push('/courses')} className="hover:text-[var(--accent)]">All Courses</button> / {selectedCourse.title}</p>}
      <div className="flex gap-5 items-start">

      {/* LEFT — Featured lecture video (from the database) */}
      <div className="w-[55%] shrink-0">
        <div className="relative w-full aspect-video rounded-card overflow-hidden bg-black shadow-md">
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
          <p className="mt-3 text-h3 font-semibold text-[var(--text)] leading-snug">
            {featured.title}
          </p>
        )}
      </div>

      {/* RIGHT — Lecture list */}
      <div className="flex-1 min-w-0 bg-white rounded-card border border-[var(--border)] shadow-md flex flex-col overflow-hidden">

        {/* Header */}
        <div className="px-4 py-4 border-b border-[var(--border)]">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-h2 font-semibold text-[var(--text)]">{selectedCourse ? selectedCourse.title : 'All Lectures'}</h1>
              <p className="text-label text-[var(--muted)] mt-1">
                {ordered.length} lecture{ordered.length !== 1 ? 's' : ''} available
              </p>
            </div>
            {firstReady && (
              <button
                onClick={() => router.push(`/lecture/${firstReady.id}`)}
                className="flex items-center gap-2 h-10 px-5 bg-[var(--accent)] hover:bg-[var(--accent-deep)] text-white rounded-control text-label font-semibold transition-colors shrink-0"
              >
                <i className="fas fa-play text-[10px]" /> Start Learning
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
              const badge   = statusBadge(lec.status);
              const isReady = isLectureReady(lec.status);
              return (
                <div
                  key={lec.id}
                  onClick={() => isReady && router.push(`/lecture/${lec.id}`)}
                  className={`group flex gap-3 px-4 py-3 border-b border-[var(--border)] transition-colors ${
                    isReady ? 'cursor-pointer hover:bg-[var(--surface)]' : 'opacity-60 cursor-default'
                  }`}
                >
                  {/* Thumbnail */}
                  {lec.youtubeVideoId ? (
                    <div className="w-[78px] shrink-0 aspect-video rounded-control overflow-hidden bg-black border border-[var(--border)]">
                      {/* YouTube thumbnails are whatever colour the video author
                          chose, so a row of them fights the page. Holding them
                          slightly muted until the row is hovered lets them sit
                          inside our palette while staying recognisable. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`https://i.ytimg.com/vi/${lec.youtubeVideoId}/hqdefault.jpg`}
                        alt={lec.title}
                        className="w-full h-full object-cover saturate-[.7] opacity-90 transition duration-200 group-hover:saturate-100 group-hover:opacity-100"
                      />
                    </div>
                  ) : (
                    <div className="w-[78px] shrink-0 aspect-video rounded-control bg-[var(--surface)] border border-[var(--border)] flex items-center justify-center">
                      <i className="fas fa-play-circle text-lg text-[var(--muted)]" />
                    </div>
                  )}

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-label font-semibold leading-snug line-clamp-2 mb-2 text-[var(--text)]">
                      {lec.title}
                    </p>
                    {/* Ready is the normal case for every row, so saying it on
                        each one is noise that reads like a status update. Only
                        a lecture that is NOT ready is labelled, because that is
                        the case a student needs to notice. */}
                    {isReady ? null : (
                      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-caption font-medium ${badge.color}`}>
                        <i className="fas fa-clock text-[9px]" />
                        {badge.label}
                      </span>
                    )}
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
