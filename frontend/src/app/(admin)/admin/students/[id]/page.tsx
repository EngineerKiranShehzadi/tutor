'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useApolloClient, useQuery } from '@apollo/client';
import { GET_STUDENT_JOURNEY } from '@/graphql/analytics.queries';
import { AdminPageHero } from '@/components/admin/AdminPageHero';

interface JourneyQuestion { id: number; question: string; lectureTitle: string; lectureId: number; createdAt: string }
interface LectureEngagement { lectureId: number; lectureTitle: string; questionCount: number; firstAsked: string; lastAsked: string }
interface StudentJourney {
  studentId: string; studentName: string; studentEmail: string;
  status: string; questionCount: number; lecturesEngaged: number;
  joinedAt: string; firstActivity: string | null; lastActivity: string | null;
  questions: JourneyQuestion[];   // one page; questionCount is the total
  hasMoreQuestions: boolean;
  byLecture: LectureEngagement[];
}

// The question list is served a page at a time (AD6); "Load more" appends.
const QUESTIONS_PAGE = 25;

const outlineBtn = 'rounded-control border border-[var(--border)] px-3.5 py-2 text-caption font-semibold text-[var(--text)] hover:bg-[var(--surface)] transition-colors disabled:opacity-50';

/**
 * One student.
 *
 * This page had a header of its own instead of the one every other admin page
 * uses, drew its per-lecture figures as a recharts bar chart in six rotating
 * colours, gave the student an avatar tinted at random, and numbered the
 * questions #1, #2, #3 — numbers that counted down the page rather than
 * meaning anything. The bars are now the same horizontal form as Overview.
 */
export default function StudentJourneyPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const client = useApolloClient();
  const { data, loading, error } = useQuery(GET_STUDENT_JOURNEY, {
    variables: { id, limit: QUESTIONS_PAGE, offset: 0 },
    fetchPolicy: 'network-only',
  });

  const journey: StudentJourney | undefined = data?.studentJourney;
  const [moreQuestions, setMoreQuestions] = useState<JourneyQuestion[]>([]);
  const [moreHasMore,   setMoreHasMore]   = useState<boolean | null>(null);
  const [loadingMore,   setLoadingMore]   = useState(false);
  const questions = [...(journey?.questions ?? []), ...moreQuestions];
  const canLoadMore = moreHasMore ?? journey?.hasMoreQuestions ?? false;

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const { data: d } = await client.query<{ studentJourney: StudentJourney }>({
        query: GET_STUDENT_JOURNEY,
        variables: { id, limit: QUESTIONS_PAGE, offset: questions.length },
        fetchPolicy: 'network-only',
      });
      setMoreQuestions(prev => [...prev, ...d.studentJourney.questions]);
      setMoreHasMore(d.studentJourney.hasMoreQuestions);
    } catch {
      setMoreHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  };

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtWhen = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  if (loading && !data) {
    return (
      <div className="max-w-[1180px]">
        <div className="h-20 rounded-card bg-[var(--card)] border border-[var(--border)] animate-pulse mb-5" />
        <div className="h-64 rounded-card bg-[var(--card)] border border-[var(--border)] animate-pulse" />
      </div>
    );
  }

  if (error || !journey) {
    return (
      <div className="max-w-[1180px]">
        <div className="rounded-card border border-[var(--border)] bg-[var(--card)] p-10 text-center">
          <p className="text-label font-semibold text-[var(--text)]">Student not found</p>
          <p className="text-caption text-[var(--muted)] mt-1">They may have been deleted.</p>
          <Link href="/admin/students" className="mt-4 inline-block text-label font-semibold text-[var(--accent)] hover:underline">
            Back to Students
          </Link>
        </div>
      </div>
    );
  }

  const maxCount = journey.byLecture.reduce((m, l) => Math.max(m, l.questionCount), 0);

  return (
    <div className="max-w-[1180px]">
      <AdminPageHero
        parent={{ label: 'Students', href: '/admin/students' }}
        title={journey.studentName}
        subtitle={`${journey.studentEmail} · Joined ${fmtDate(journey.joinedAt)}`}
      />

      {journey.questionCount === 0 ? (
        <div className="rounded-card border border-[var(--border)] bg-[var(--card)] p-10 text-center">
          <p className="text-label font-semibold text-[var(--text)]">Has not asked anything yet</p>
          <p className="text-caption text-[var(--muted)] mt-1">
            Their questions will appear here once they start using the tutor.
          </p>
        </div>
      ) : (
        <>
          {/* A line, not a card of three figures. Three short facts do not
              need three bordered boxes to be read. */}
          <p className="text-label text-[var(--text)] mb-5">
            <b className="tabular-nums">{journey.questionCount.toLocaleString()}</b>{' '}
            {journey.questionCount === 1 ? 'question' : 'questions'} across{' '}
            <b className="tabular-nums">{journey.lecturesEngaged}</b>{' '}
            {journey.lecturesEngaged === 1 ? 'lecture' : 'lectures'}
            {journey.firstActivity && journey.lastActivity && (
              <span className="text-[var(--muted)]">
                , from {fmtDate(journey.firstActivity)} to {fmtDate(journey.lastActivity)}
              </span>
            )}
          </p>

          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_420px] gap-5 items-start">
            <section className="rounded-card border border-[var(--border)] bg-[var(--card)] p-6">
              <h2 className="text-h3 font-semibold text-[var(--text)]">Questions per Lecture</h2>
              <p className="text-caption text-[var(--muted)] mt-0.5 mb-5">Where this student spent their time</p>

              <ol className="space-y-3.5">
                {[...journey.byLecture].sort((a, b) => b.questionCount - a.questionCount).map(l => (
                  <li key={l.lectureId}>
                    <div className="flex items-baseline justify-between gap-4 mb-1.5">
                      <Link
                        href={`/admin/lectures/${l.lectureId}`}
                        className="text-label text-[var(--text)] truncate hover:underline"
                        title={l.lectureTitle}
                      >
                        {l.lectureTitle}
                      </Link>
                      <span className="text-label font-semibold text-[var(--text)] shrink-0 tabular-nums">{l.questionCount}</span>
                    </div>
                    <div className="h-2 rounded-full bg-[var(--surface)] border border-[var(--border)] overflow-hidden">
                      <div
                        className="h-full rounded-full bg-[var(--accent)]"
                        style={{ width: `${maxCount ? Math.max(Math.round((l.questionCount / maxCount) * 100), 2) : 0}%` }}
                      />
                    </div>
                    <p className="text-caption text-[var(--muted)] mt-1">
                      {fmtDate(l.firstAsked)} to {fmtDate(l.lastAsked)}
                    </p>
                  </li>
                ))}
              </ol>
            </section>

            <section className="rounded-card border border-[var(--border)] bg-[var(--card)] p-6">
              <h2 className="text-h3 font-semibold text-[var(--text)]">Questions</h2>
              <p className="text-caption text-[var(--muted)] mt-0.5 mb-4">Newest first</p>

              <ul className="space-y-4 max-h-[360px] overflow-y-auto pr-2">
                {questions.map(q => (
                  <li key={q.id}>
                    <p className="text-label text-[var(--text)] leading-relaxed">{q.question}</p>
                    <p className="text-caption text-[var(--muted)] mt-1 truncate">
                      {q.lectureTitle} · {fmtWhen(q.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>

              {canLoadMore && (
                <button onClick={() => void loadMore()} disabled={loadingMore} className={`${outlineBtn} mt-4`}>
                  {loadingMore ? 'Loading…' : 'Show More'}
                </button>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
