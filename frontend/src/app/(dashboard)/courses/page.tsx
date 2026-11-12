'use client';
import { useRouter } from 'next/navigation';
import { useQuery } from '@apollo/client';
import { GET_COURSES } from '@/graphql/course.queries';
import { DBCourse } from '@/types/course';

export default function CoursesPage() {
  const router = useRouter();
  const { data, loading, error, refetch } = useQuery(GET_COURSES, { fetchPolicy: 'cache-and-network' });
  const courses: DBCourse[] = data?.courses ?? [];

  return (
    <div className="px-6 py-8 max-w-[1400px] mx-auto">
      <div className="mb-7">
        <h1 className="text-h2 font-semibold text-[var(--text)]">Courses</h1>
        <p className="text-label text-[var(--muted)] mt-1">Choose a course to explore its lectures and AI tutors.</p>
      </div>
      {loading && !data ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-4 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : error && !data ? (
        <div role="alert" className="bg-white border border-[var(--border)] rounded-card p-8 text-center">
          <p className="text-red-600 mb-4">Courses could not be loaded.</p>
          <button onClick={() => void refetch()} className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-deep)] text-white rounded-control text-label transition-colors">Try again</button>
        </div>
      ) : courses.length === 0 ? (
        <div className="rounded-card border border-[var(--border)] bg-white py-16 text-center text-[var(--muted)]">
          <i className="fas fa-layer-group text-3xl block mb-3" />
          <p className="font-semibold">No courses available yet</p>
        </div>
      ) : (
        // A single course in a three-column grid sits in a narrow box with the
        // rest of the row empty. One card is given a wider, readable width of
        // its own; two or more fall back to the grid.
        <div className={courses.length === 1 ? 'grid gap-5 max-w-[720px]' : 'grid gap-5 sm:grid-cols-2 xl:grid-cols-3'}>
          {courses.map(course => (
            <button
              type="button"
              key={course.id}
              onClick={() => router.push(`/lectures?courseId=${encodeURIComponent(course.id)}`)}
              className="text-left rounded-card border border-[var(--border)] bg-white p-6 shadow-md hover:shadow-lg hover:border-[var(--accent)] transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            >
              <div className="flex justify-between items-start gap-3 mb-4">
                <div className="w-12 h-12 rounded-control bg-[var(--accent-soft)] flex items-center justify-center">
                  <i className="fas fa-book-open text-[var(--accent)] text-xl" />
                </div>
                <span className="text-caption text-[var(--muted)] bg-[var(--surface)] rounded-control px-2.5 py-1">
                  {course.lectureCount} lecture{course.lectureCount === 1 ? '' : 's'}
                </span>
              </div>
              <h2 className="font-semibold text-h3 text-[var(--text)] mb-2">{course.title}</h2>
              {course.subtitle && <p className="text-label text-[var(--muted)] mb-2">{course.subtitle}</p>}
              {course.description && <p className="text-label text-[var(--muted2)] line-clamp-3 mb-4">{course.description}</p>}
              <div className="flex items-center justify-between mt-5 pt-4 border-t border-[var(--border)]">
                <span className="text-caption text-[var(--muted)]">{course.readyCount} AI tutors ready</span>
                <span className="text-label text-[var(--accent)] font-semibold">View lectures <i className="fas fa-arrow-right text-[11px] ml-1" /></span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
