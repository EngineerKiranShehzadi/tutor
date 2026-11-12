'use client';
import Link from 'next/link';
import { type ReactNode } from 'react';
import { useQuery } from '@apollo/client';
import { cn } from '@/lib/cn';
import { MY_STATS_QUERY, MY_RECENT_QUESTIONS_QUERY } from '@/graphql/analytics.queries';
import { GET_PRACTICE_PROGRESS } from '@/graphql/practice.queries';

/**
 * My activity — where to pick the work back up.
 *
 * What this page is NOT: a record of what the student typed. The answer, its
 * sources and the point in the video it came from only make sense next to the
 * lecture, and the lecture page already keeps that history. Listing the
 * questions here as well put the same data in two places, and the copy here
 * was the worse one — question text with the answer stripped off.
 *
 * So the page answers one question: "where do I go back to?" Resume card,
 * three counts, the last seven days, and a way into each lecture.
 *
 * Everything shown is a count the database holds. An earlier version had a
 * "Curiosity Score" (the question count renamed), a "Knowledge Coverage"
 * percentage (lectures opened, which is neither knowledge nor coverage), a
 * badge ladder awarding "Power Learner" at twenty questions, a "Peak Learning
 * Time" inferred from a handful of timestamps, and per-lecture labels of
 * Touched / Explored / Deep Dive on invented thresholds. None could be
 * explained if an examiner asked how it was calculated.
 *
 * It also used to show "No questions yet" when the request had actually
 * failed, so a dropped database connection looked like an empty account.
 * Failure and emptiness are now two different screens.
 */

/** "Today, 3:12 PM" · "Yesterday, 9:04 AM" · "2 Nov, 9:04 AM" — browser's own clock. */
function formatWhen(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const diff = Math.round(
    (new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000
  );
  if (diff === 0) return `Today, ${time}`;
  if (diff === 1) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`;
}

function Stat({ value, label, hint }: { value: string; label: string; hint?: string }) {
  return (
    <div className="bg-white border border-[var(--border)] rounded-card px-5 py-5">
      <p className="text-h1 font-semibold text-[var(--text)] leading-none tabular-nums">{value}</p>
      <p className="text-label font-medium text-[var(--text)] mt-3">{label}</p>
      {hint && <p className="text-caption text-[var(--muted)] mt-1">{hint}</p>}
    </div>
  );
}

function Section({ title, hint, right, children }: {
  title: string; hint?: string; right?: ReactNode; children: ReactNode;
}) {
  return (
    <section className="bg-white border border-[var(--border)] rounded-card p-6 mt-4">
      <div className="flex items-baseline justify-between gap-4 mb-5">
        <div className="min-w-0">
          <h2 className="text-h3 font-semibold text-[var(--text)]">{title}</h2>
          {hint && <p className="text-caption text-[var(--muted)] mt-1">{hint}</p>}
        </div>
        {right && <p className="text-caption text-[var(--muted)] shrink-0">{right}</p>}
      </div>
      {children}
    </section>
  );
}

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-card bg-[var(--surface)] ${className}`} />;
}

export default function ActivityPage() {
  // notifyOnNetworkStatusChange: without it Apollo leaves `loading` false
  // while a refetch is in flight, so pressing Try again re-ran the query but
  // the button never changed and the screen never moved — it looked dead.
  const stats = useQuery(MY_STATS_QUERY, {
    fetchPolicy: 'network-only',
    notifyOnNetworkStatusChange: true,
  });
  // limit 1: the single most recent question, used only to name the lecture to
  // return to. The full list is deliberately not shown here.
  const recent = useQuery(MY_RECENT_QUESTIONS_QUERY, {
    variables: { limit: 1, offset: 0 },
    fetchPolicy: 'network-only',
    notifyOnNetworkStatusChange: true,
  });

  // Lifetime quiz totals. They were shown on the practice page beside the
  // results of a single quiz, which read as two competing scoreboards; "how am
  // I doing overall" belongs here instead. A failure is silent: this is an
  // extra panel, not the reason the page exists.
  const quiz = useQuery(GET_PRACTICE_PROGRESS, { fetchPolicy: 'cache-and-network' });
  const quizStats = quiz.data?.myPracticeProgress as
    | { attempts:number; answered:number; correct:number; percent:number;
        lectures:{lectureId:number;lectureTitle:string;total:number;correct:number;percent:number}[] }
    | undefined;

  const s = stats.data?.myStats;

  const total     = s?.totalQuestions ?? 0;
  const thisWeek  = s?.thisWeekQuestions ?? 0;
  const lastWeek  = s?.lastWeekQuestions ?? 0;
  const engaged   = s?.lecturesEngaged ?? 0;
  const available = s?.totalAvailableLectures ?? 0;

  const weekly     = (s?.weeklyActivity ?? []) as { day: string; date: string; count: number }[];
  const maxDay     = Math.max(...weekly.map(d => d.count), 1);
  const activeDays = weekly.filter(d => d.count > 0).length;

  const byLecture = (s?.lectureBreakdown ?? []) as { lectureId: number; lectureTitle: string; count: number }[];

  const last = (recent.data?.myRecentQuestions?.items ?? [])[0] as
    | { lectureId: number; lectureTitle: string; createdAt: string }
    | undefined;

  const retry = () => {
    // Both can reject when the server is still down. Swallow it: the error
    // screen is already showing the outcome, and an unhandled rejection would
    // leave the button stuck mid-press.
    stats.refetch().catch(() => undefined);
    recent.refetch().catch(() => undefined);
  };

  const header = (
    <>
      <h1 className="text-h1 font-semibold text-[var(--text)]">My Activity</h1>
      <p className="text-body text-[var(--muted)] mt-2 mb-8">
        Your questions so far, and where to pick up again.
      </p>
    </>
  );

  // ── 1. First load ──────────────────────────────────────────────────────
  if (stats.loading && !s) {
    return (
      <div className="max-w-[1000px] mx-auto px-6 py-10">
        {header}
        <div className="grid sm:grid-cols-3 gap-4">
          <Skeleton className="h-[118px]" />
          <Skeleton className="h-[118px]" />
          <Skeleton className="h-[118px]" />
        </div>
        <Skeleton className="h-[220px] mt-4" />
      </div>
    );
  }

  // ── 2. The request failed ──────────────────────────────────────────────
  // Distinct from an empty account. The usual cause is the backend being
  // unreachable or the database connection dropping, and showing "no questions"
  // for that sent us looking in the wrong place for half an hour.
  if (stats.error && !s) {
    return (
      <div className="max-w-[1000px] mx-auto px-6 py-10">
        {header}
        <div className="bg-white border border-[var(--border)] rounded-card px-6 py-14 text-center">
          <i className="fas fa-triangle-exclamation text-h2 text-[var(--muted2)]" />
          <p className="text-h3 font-semibold text-[var(--text)] mt-4">Could not load your activity</p>
          <p className="text-body text-[var(--muted)] mt-2 mb-6 max-w-[460px] mx-auto">
            The server did not answer. Check that you are online, then try again.
            Nothing of yours has been lost.
          </p>
          <button
            type="button"
            onClick={retry}
            disabled={stats.loading}
            className="inline-flex items-center gap-2 h-11 px-6 rounded-control bg-[var(--accent)] hover:bg-[var(--accent-deep)] active:bg-[var(--accent-deep)] active:scale-[0.97] text-white text-label font-semibold transition-all disabled:opacity-60"
          >
            <i className={cn('fas fa-rotate-right text-caption', stats.loading && 'animate-spin')} />
            {stats.loading ? 'Trying…' : 'Try again'}
          </button>
        </div>
      </div>
    );
  }

  // ── 3. Genuinely nothing asked yet ─────────────────────────────────────
  if (total === 0) {
    return (
      <div className="max-w-[1000px] mx-auto px-6 py-10">
        {header}
        <div className="bg-white border border-[var(--border)] rounded-card px-6 py-14 text-center">
          <p className="text-h3 font-semibold text-[var(--text)]">No questions yet</p>
          <p className="text-body text-[var(--muted)] mt-2 mb-6">
            Open a lecture and ask something. What you ask will be tracked here.
          </p>
          <Link
            href="/courses"
            className="inline-flex items-center h-11 px-6 rounded-control bg-[var(--accent)] hover:bg-[var(--accent-deep)] text-white text-label font-semibold transition-colors"
          >
            Go to lectures
          </Link>
        </div>
      </div>
    );
  }

  // ── 4. The page ────────────────────────────────────────────────────────
  return (
    <div className="max-w-[1000px] mx-auto px-6 py-10">
      {header}

      {/* Resume. The one thing a student coming back actually wants, and the
          only place the most recent question is used — to name the lecture. */}
      {last && (
        <div className="bg-[var(--accent)] rounded-card px-6 py-5 mb-4 flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-caption font-semibold tracking-wide" style={{ color: 'var(--accent-dim)' }}>
              Continue where you left off
            </p>
            <p className="text-label font-semibold text-white mt-1.5 truncate">
              {last.lectureTitle}
            </p>
            <p className="text-caption mt-1" style={{ color: '#a3a7ad' }}>
              You last asked here {formatWhen(last.createdAt)}
            </p>
          </div>
          <Link
            href={`/lecture/${last.lectureId}`}
            className="inline-flex items-center gap-2 h-10 px-5 rounded-control bg-white text-[var(--ink)] text-label font-semibold transition-colors hover:bg-[var(--accent-soft)] shrink-0"
          >
            Open lecture
            <i className="fas fa-arrow-right text-caption" />
          </Link>
        </div>
      )}

      <div className="grid sm:grid-cols-3 gap-4">
        <Stat value={String(total)} label="Questions asked" hint="since you joined" />
        <Stat value={`${engaged} of ${available}`} label="Lectures used" hint="lectures you have asked in" />
        <Stat value={`${activeDays} of 7`} label="Active days" hint="days you asked something" />
      </div>

      {/* The two figures in the header cover the same seven calendar days the
          bars show, so they cannot disagree with them. */}
      <Section
        title="Last seven days"
        right={<>{thisWeek} asked · {lastWeek} in the seven days before</>}
      >
        <div className="flex items-end gap-3 h-[120px]">
          {weekly.map(d => (
            <div key={d.date} className="flex-1 flex flex-col items-center gap-2 h-full justify-end">
              {d.count > 0 && (
                <span className="text-caption font-medium text-[var(--muted)] tabular-nums">{d.count}</span>
              )}
              <div
                className="w-full rounded-[4px] bg-[var(--accent)]"
                style={{
                  height: `${Math.max((d.count / maxDay) * 78, d.count > 0 ? 6 : 2)}%`,
                  opacity: d.count > 0 ? 1 : 0.18,
                }}
                title={`${d.count} on ${d.date}`}
              />
              <span className="text-caption text-[var(--muted2)]">{d.day}</span>
            </div>
          ))}
        </div>
      </Section>

      {quizStats && quizStats.attempts > 0 && (
        <Section
          title="Practice quizzes"
          hint="Across every quiz you have submitted."
          right={<Link href="/practice" className="font-semibold text-[var(--accent)] hover:underline">Take a quiz</Link>}
        >
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: 'Quizzes taken',      value: String(quizStats.attempts) },
              { label: 'Questions answered', value: String(quizStats.answered) },
              { label: 'Accuracy',           value: quizStats.answered ? `${quizStats.percent}%` : '—' },
            ].map(tile => (
              <div key={tile.label} className="rounded-card border border-[var(--border)] bg-[var(--surface)] px-4 py-4">
                <p className="text-h1 font-semibold text-[var(--text)] leading-none tabular-nums">{tile.value}</p>
                <p className="text-caption text-[var(--muted)] mt-2">{tile.label}</p>
              </div>
            ))}
          </div>
          {quizStats.lectures.length > 0 && (
            <div className="mt-5 space-y-3">
              {quizStats.lectures.map(l => (
                <div key={l.lectureId}>
                  <div className="flex justify-between gap-3 text-label mb-1.5">
                    <span className="text-[var(--text)] truncate">{l.lectureTitle}</span>
                    <span className="text-[var(--muted)] shrink-0 font-semibold tabular-nums">{l.percent}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-[var(--surface)] border border-[var(--border)] overflow-hidden">
                    <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${l.percent}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      <Section
        title="Questions by lecture"
        hint="Open a lecture to read its answers again, with their sources."
      >
        <ul className="flex flex-col">
          {byLecture.map(l => (
            <li key={l.lectureId} className="border-t border-[var(--border)] first:border-t-0">
              <Link
                href={`/lecture/${l.lectureId}`}
                className="group flex items-center gap-4 py-3.5 -mx-2 px-2 rounded-control transition-colors hover:bg-[var(--surface)]"
              >
                <span className="text-label font-medium text-[var(--text)] truncate flex-1 min-w-0 group-hover:text-[var(--accent)] transition-colors">
                  {l.lectureTitle}
                </span>
                <span className="text-caption text-[var(--muted)] shrink-0 tabular-nums">
                  {l.count} {l.count === 1 ? 'question' : 'questions'}
                </span>
                <i className="fas fa-chevron-right text-caption text-[var(--muted2)] shrink-0" />
              </Link>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
