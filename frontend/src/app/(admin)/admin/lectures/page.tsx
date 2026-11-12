'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useApolloClient, useQuery, useMutation } from '@apollo/client';
import { GET_COURSES } from '@/graphql/course.queries';
import {
  ARCHIVE_LECTURE_MUTATION, DELETE_LECTURE_MUTATION, GET_LECTURES, RESTORE_LECTURE_MUTATION,
} from '@/graphql/lecture.queries';
import { GET_LECTURE_AGENT_DETAILS } from '@/graphql/admin.queries';
import { GET_QUESTIONS_PER_LECTURE } from '@/graphql/analytics.queries';
import { DBCourse } from '@/types/course';
import { DBLecture } from '@/types';
import { AdminPageHero } from '@/components/admin/AdminPageHero';

/**
 * Lectures.
 *
 * The page used to open with four number cards in four different colours, then
 * repeat those same numbers nowhere useful, and number its rows #1, #2, #3 —
 * which read as lecture order but were row positions in a newest-first list, so
 * Lecture 6 was #1. The status pills ran through emerald, blue, violet, amber,
 * slate and red, and the New Lecture button was white on a white heading, so it
 * could not be seen at all.
 *
 * The counts are now the filter: pressing "Processing" shows the processing
 * lectures. Nothing on the page states a number it cannot act on.
 */

type StatusKey = 'READY' | 'PROCESSING' | 'EMBEDDING' | 'DATASET_UPLOADED' | 'NO_DATASET' | 'FAILED';

// Gold marks the states an admin has to act on; everything else stays muted,
// so the list is quiet until something actually needs doing.
const STATUS: Record<StatusKey, { label: string; attention: boolean }> = {
  READY:            { label: 'Tutor ready',      attention: false },
  PROCESSING:       { label: 'Processing',       attention: false },
  EMBEDDING:        { label: 'Embedding',        attention: false },
  DATASET_UPLOADED: { label: 'Dataset uploaded', attention: true  },
  NO_DATASET:       { label: 'No dataset',       attention: true  },
  FAILED:           { label: 'Failed',           attention: true  },
};

type Tab = 'ALL' | StatusKey | 'ARCHIVED';
type Pending = { id: string; action: 'archive' | 'delete' } | null;

const outlineBtn = 'rounded-control border border-[var(--border)] px-3.5 py-2 text-caption font-semibold text-[var(--text)] hover:bg-[var(--surface)] transition-colors disabled:opacity-50';

export default function AdminLectures() {
  const router = useRouter();
  const client = useApolloClient();

  // Archived lectures are included here and nowhere else: this is the only
  // page that can restore one.
  const { data, loading, refetch } = useQuery(GET_LECTURES, {
    variables: { includeArchived: true },
    fetchPolicy: 'network-only',
  });
  const { data: agentData, loading: agentLoading } = useQuery(GET_LECTURE_AGENT_DETAILS, { fetchPolicy: 'network-only' });
  const { data: courseData } = useQuery(GET_COURSES, { variables: { includeArchived: true } });
  // Already fetched by Overview; reused so the delete warning can state a real
  // number instead of a vague caution.
  const { data: askedData } = useQuery(GET_QUESTIONS_PER_LECTURE, { fetchPolicy: 'network-only' });

  const [archiveLecture, { loading: archiving }] = useMutation(ARCHIVE_LECTURE_MUTATION);
  const [restoreLecture, { loading: restoring }] = useMutation(RESTORE_LECTURE_MUTATION);
  const [deleteLecture,  { loading: deleting }]  = useMutation(DELETE_LECTURE_MUTATION);

  const [search, setSearch] = useState('');
  const [courseFilter, setCourseFilter] = useState('');
  const [tab, setTab] = useState<Tab>('ALL');
  const [pending, setPending] = useState<Pending>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    setCourseFilter(new URLSearchParams(window.location.search).get('courseId') ?? '');
  }, []);
  // A status chosen for one course may not exist in the next one.
  useEffect(() => {
    if (tab !== 'ALL' && tab !== 'ARCHIVED' && countOf(tab as StatusKey) === 0) setTab('ALL');
    if (tab === 'ARCHIVED' && scopedArchived.length === 0) setTab('ALL');
  });

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const courses: DBCourse[] = courseData?.courses ?? [];
  const all: DBLecture[] = useMemo(() => data?.lectures ?? [], [data]);

  const agentById = useMemo(() => new Map<number, { chatReady: boolean; notReadyReason: string | null }>(
    (agentData?.lectureAgentDetails ?? []).map((a: { id: number; chatReady: boolean; notReadyReason: string | null }) => [a.id, a])
  ), [agentData]);

  const askedById = useMemo(() => new Map<number, number>(
    (askedData?.questionsPerLecture ?? []).map((q: { lectureId: number; count: number }) => [q.lectureId, q.count])
  ), [askedData]);

  const activeOnes = all.filter(l => !l.archivedAt);
  const archived   = all.filter(l => l.archivedAt);

  // Scoped to the chosen course. Built from every lecture instead, a course
  // whose lectures are all ready would still offer a "No dataset" button that
  // returned nothing.
  const inCourse = (list: DBLecture[]) => courseFilter ? list.filter(l => l.courseId === courseFilter) : list;
  const scopedActive   = inCourse(activeOnes);
  const scopedArchived = inCourse(archived);
  const countOf = (key: StatusKey) => scopedActive.filter(l => l.status === key).length;

  // Only states that actually occur get a tab, and the row is dropped entirely
  // when every lecture is in the same state: filtering a list into itself is a
  // control that does nothing.
  const presentStates = (Object.keys(STATUS) as StatusKey[]).filter(k => countOf(k) > 0);
  const tabs: { key: Tab; label: string }[] = [
    { key: 'ALL', label: 'All' },
    ...presentStates.map(k => ({ key: k as Tab, label: STATUS[k].label })),
    ...(archived.length ? [{ key: 'ARCHIVED' as Tab, label: 'Archived' }] : []),
  ];

  const showTabs = presentStates.length > 1 || scopedArchived.length > 0;
  // A dataset still being prepared changes status on its own, so the list is
  // worth reloading. Nothing in progress means nothing to reload.
  const inProgress = scopedActive.some(l =>
    l.status === 'PROCESSING' || l.status === 'EMBEDDING' || l.status === 'DATASET_UPLOADED');

  const base = tab === 'ARCHIVED' ? scopedArchived : scopedActive;
  const lectures = base.filter(l =>
    (tab === 'ALL' || tab === 'ARCHIVED' || l.status === tab) &&
    (!search || l.title.toLowerCase().includes(search.toLowerCase()))
  );

  // True when a search, a course or a status is hiding part of the list.
  const narrowed = Boolean(search) || Boolean(courseFilter) || tab !== 'ALL';

  const courseName = (id?: string) => {
    const c = courses.find(x => x.id === id);
    if (!c) return null;
    return c.archivedAt ? `${c.title} (archived)` : c.title;
  };

  /** Students, the chat and Overview each hold their own copy of this list. */
  const purgeLectureLists = () => {
    client.cache.evict({ id: 'ROOT_QUERY', fieldName: 'lectures' });
    client.cache.gc();
  };

  const run = async (lec: DBLecture, action: 'archive' | 'restore' | 'delete') => {
    setRowError(null); setNotice('');
    try {
      if (action === 'archive') {
        await archiveLecture({ variables: { id: lec.id } });
        setNotice(`${lec.title} has been archived. Its dataset and question history are unchanged.`);
      } else if (action === 'restore') {
        await restoreLecture({ variables: { id: lec.id } });
        setNotice(`${lec.title} is available to students again.`);
      } else {
        await deleteLecture({ variables: { id: lec.id } });
        setNotice(`${lec.title} has been deleted.`);
      }
      setPending(null);
      purgeLectureLists();
      await refetch();
    } catch (err) {
      setRowError({
        id: lec.id,
        message: (err as { graphQLErrors?: { message: string }[] })?.graphQLErrors?.[0]?.message ?? 'That action could not be completed.',
      });
      setPending(null);
    }
  };

  const busy = archiving || restoring || deleting;

  return (
    <div className="max-w-[1180px]">
      <AdminPageHero
        title="Lectures"
        subtitle="Every lecture in the system. Open one to work on its dataset or its tutor." 
        action={
          <Link
            href={courseFilter ? `/admin/lectures/create?courseId=${encodeURIComponent(courseFilter)}` : '/admin/lectures/create'}
            className="h-10 inline-flex items-center gap-2 rounded-control bg-[var(--accent)] px-5 text-label font-semibold text-white hover:bg-[var(--accent-deep)] transition-colors"
          >
            <i className="fas fa-plus text-[12px]" aria-hidden="true" />
            New Lecture
          </Link>
        }
      />

      {notice && (
        <div role="status" className="mb-5 flex items-center gap-2.5 rounded-card border border-[var(--border)] border-l-[3px] border-l-[var(--accent)] bg-[var(--card)] px-5 py-3.5">
          <i className="fas fa-circle-check text-[13px] text-[var(--accent)]" aria-hidden="true" />
          <p className="text-label text-[var(--text)]">{notice}</p>
        </div>
      )}

      {/* The four number cards are gone. Each count is a filter now, so the
          figures on the page are things you can act on. */}
      {showTabs && (
      <div className="flex flex-wrap gap-2 mb-4">
        {tabs.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => { setTab(t.key); setPending(null); }}
            className={`rounded-control px-3.5 py-2 text-caption font-semibold transition-colors ${
              tab === t.key
                ? 'bg-[var(--accent)] text-white'
                : 'border border-[var(--border)] text-[var(--text)] hover:bg-[var(--surface)]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      )}

      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="relative flex-1 min-w-[240px]">
          <i className="fas fa-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-[13px] text-[var(--muted2)]" aria-hidden="true" />
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); setPending(null); }}
            placeholder="Search lectures by title"
            className="w-full rounded-control border border-[var(--border)] bg-[var(--card)] pl-10 pr-4 py-2.5 text-label text-[var(--text)] outline-none transition-colors focus:border-[var(--muted)] placeholder:text-[var(--muted2)]"
          />
        </div>
        {/* The browser's own arrow sits hard against the right edge, so it is
            replaced with one set in from it. */}
        <div className="relative">
          <select
            aria-label="Filter by course"
            value={courseFilter}
            onChange={e => { setCourseFilter(e.target.value); setPending(null); }}
            className="appearance-none rounded-control border border-[var(--border)] bg-[var(--card)] pl-3.5 pr-10 py-2.5 text-label text-[var(--text)] outline-none transition-colors focus:border-[var(--muted)]"
          >
            <option value="">All courses</option>
            {courses.map(c => (
              <option key={c.id} value={c.id}>{c.archivedAt ? `${c.title} (archived)` : c.title}</option>
            ))}
          </select>
          <i className="fas fa-chevron-down pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[11px] text-[var(--muted)]" aria-hidden="true" />
        </div>
        <Link href="/admin/courses" className={`${outlineBtn} bg-[var(--card)] py-2.5`}>
          Manage Courses
        </Link>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-[86px] rounded-card border border-[var(--border)] bg-[var(--card)] animate-pulse" />
          ))}
        </div>
      ) : lectures.length === 0 ? (
        <div className="rounded-card border border-[var(--border)] bg-[var(--card)] p-10 text-center">
          <p className="text-label font-semibold text-[var(--text)]">
            {all.length === 0 ? 'No lectures yet' : 'Nothing matches those filters'}
          </p>
          <p className="text-caption text-[var(--muted)] mt-1">
            {all.length === 0
              ? 'Create a lecture, then upload its dataset to start its tutor.'
              : 'Clear the search or choose a different course.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {lectures.map(lec => {
            const isArchived = Boolean(lec.archivedAt);
            const s = STATUS[(lec.status as StatusKey)] ?? STATUS.NO_DATASET;
            const agent = agentById.get(Number(lec.id));
            const tutorStuck = lec.status === 'READY' && agent?.chatReady === false;
            const asked = askedById.get(Number(lec.id)) ?? 0;
            const confirming = pending?.id === lec.id ? pending.action : null;
            const failed = rowError?.id === lec.id ? rowError.message : null;

            return (
              <div key={lec.id} className="rounded-card border border-[var(--border)] bg-[var(--card)] p-5">
                <div className="flex items-start gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-label font-semibold text-[var(--text)]">{lec.title}</p>
                    <p className="text-caption text-[var(--muted)] mt-1">
                      {courseName(lec.courseId) ?? 'Course unknown'}
                      {' · '}
                      {new Date(lec.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
                      {asked > 0 && ` · ${asked} ${asked === 1 ? 'question' : 'questions'} asked`}
                    </p>
                    {/* A dataset that finished while its tutor did not is the
                        one thing on this page that needs explaining. */}
                    {tutorStuck && agent?.notReadyReason && (
                      <p className="text-caption text-[var(--gold)] mt-1">{agent.notReadyReason}</p>
                    )}
                  </div>

                  {/* Words, not a coloured dot: a dot beside a label reads as
                      an unread marker. Only a state needing action is tinted. */}
                  <span className={`shrink-0 text-caption font-medium ${
                    tutorStuck || s.attention ? 'text-[var(--gold)]' : 'text-[var(--muted)]'
                  }`}>
                    {isArchived ? 'Archived' : tutorStuck ? 'Tutor not ready' : s.label}
                  </span>
                </div>

                {failed && (
                  <p role="alert" className="mt-3 flex items-start gap-2 text-label text-[var(--text)]">
                    <i className="fas fa-triangle-exclamation text-[13px] text-[var(--gold)] mt-1 shrink-0" aria-hidden="true" />
                    {failed}
                  </p>
                )}

                {confirming ? (
                  <div className="mt-4 pt-4 border-t border-[var(--border)]">
                    <p className="text-label text-[var(--text)]">
                      {/* The title is on the line above, so it is not repeated
                          here. One short line is enough to decide. */}
                      {confirming === 'archive'
                        ? 'Students lose access. Nothing is deleted, and you can restore it.'
                        : 'Removes its dataset and chat history for good. Cannot be undone.'}
                    </p>
                    <div className="flex flex-wrap gap-2 mt-3">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void run(lec, confirming)}
                        className="rounded-control bg-[var(--accent)] px-3.5 py-2 text-caption font-semibold text-white hover:bg-[var(--accent-deep)] transition-colors disabled:opacity-50"
                      >
                        {busy ? 'Working…' : confirming === 'archive' ? 'Archive Lecture' : 'Delete Permanently'}
                      </button>
                      <button type="button" onClick={() => setPending(null)} className={outlineBtn}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2 mt-4 pt-4 border-t border-[var(--border)]">
                    {isArchived ? (
                      <>
                        <button type="button" disabled={busy} onClick={() => void run(lec, 'restore')} className={outlineBtn}>
                          Restore
                        </button>
                        {asked === 0 && (
                          <button type="button" onClick={() => setPending({ id: lec.id, action: 'delete' })} className={outlineBtn}>
                            Delete
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <button type="button" onClick={() => router.push(`/admin/lectures/${lec.id}`)} className={outlineBtn}>
                          Open
                        </button>
                        {/* Archive is always offered: it is the safe action,
                            and a lecture nobody has asked about may still be one
                            you only want withdrawn. Delete is the extra, and
                            only where there is no question history to lose. */}
                        <button type="button" onClick={() => setPending({ id: lec.id, action: 'archive' })} className={outlineBtn}>
                          Archive
                        </button>
                        {asked === 0 && (
                          <button type="button" onClick={() => setPending({ id: lec.id, action: 'delete' })} className={outlineBtn}>
                            Delete
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!loading && lectures.length > 0 && (narrowed || inProgress) && (
        <div className="flex items-center justify-between pt-4">
          <span className="text-caption text-[var(--muted)]">
            {narrowed ? `${lectures.length} of ${scopedActive.length} shown` : ''}
          </span>
          {inProgress && (
            <button onClick={() => void refetch()} className="text-caption font-semibold text-[var(--accent)] hover:underline">
              Refresh status
            </button>
          )}
        </div>
      )}
    </div>
  );
}
