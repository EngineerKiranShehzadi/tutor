'use client';
import { useRouter } from 'next/navigation';
import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { useApolloClient, useQuery, useMutation } from '@apollo/client';
import {
  ARCHIVE_LECTURE_MUTATION, DELETE_LECTURE_MUTATION, GET_LECTURE,
  RESTORE_LECTURE_MUTATION, UPDATE_LECTURE_MUTATION,
} from '@/graphql/lecture.queries';
import { GET_COURSES } from '@/graphql/course.queries';
import { GET_LECTURE_CHUNKS } from '@/graphql/admin.queries';
import { GET_QUESTIONS_PER_LECTURE } from '@/graphql/analytics.queries';
import { DBLecture } from '@/types';
import { DBCourse } from '@/types/course';
import { AdminPageHero } from '@/components/admin/AdminPageHero';
import { DatasetManager } from '@/components/admin/DatasetManager';

interface QnaChunk { id: number; topic: string | null; question: string; answer: string; startTime: string | null; endTime: string | null; keywords: string | null }

const POLLING_STATUSES = new Set(['DATASET_UPLOADED', 'PROCESSING', 'EMBEDDING']);

/**
 * One lecture.
 *
 * Every piece of text on this page was set to 17px — labels, values, buttons,
 * badges and pagination alike — so nothing read as a heading and nothing read
 * as a caption. It also stated the lecture's status twice, printed the internal
 * database row number as "Lecture ID", drew a four-step progress list whose
 * first two steps were hardcoded as finished, and put "Back to Lectures" in
 * white on a white heading.
 *
 * The dataset section below is DatasetManager, which is not touched here.
 */

// What each state means, in the same words the Lectures list uses. Gold marks
// the states an admin has to act on.
const STATUS: Record<string, { label: string; note: string; attention: boolean }> = {
  NO_DATASET:       { label: 'No dataset',       note: 'Upload Excel, PDF, DOCX, PPTX, TXT or HTML material to start the tutor.', attention: true  },
  DATASET_UPLOADED: { label: 'Dataset uploaded', note: 'Waiting to be processed.',                                               attention: true  },
  PROCESSING:       { label: 'Processing',       note: 'Reading the dataset and preparing its chunks.',                          attention: false },
  EMBEDDING:        { label: 'Embedding',        note: 'Building the search index. This can take a few minutes.',                attention: false },
  READY:            { label: 'Tutor ready',      note: 'Students can ask about this lecture.',                                   attention: false },
  FAILED:           { label: 'Failed',           note: 'Processing did not finish. Upload the dataset again.',                   attention: true  },
};

const fieldClass = 'w-full rounded-control border border-[var(--border)] bg-[var(--card)] px-3.5 py-2.5 text-label text-[var(--text)] outline-none transition-colors focus:border-[var(--muted)] placeholder:text-[var(--muted2)]';
const outlineBtn = 'rounded-control border border-[var(--border)] px-3.5 py-2 text-caption font-semibold text-[var(--text)] hover:bg-[var(--surface)] transition-colors disabled:opacity-50';

interface Props { params: { id: string } }

export default function LectureDetailPage({ params }: Props) {
  const { data, loading, refetch } = useQuery(GET_LECTURE, {
    variables: { id: params.id },
    fetchPolicy: 'network-only',
  });
  const { data: courseData } = useQuery(GET_COURSES, { variables: { includeArchived: true } });
  const [updateLecture,  { loading: updating }]  = useMutation(UPDATE_LECTURE_MUTATION);
  const [archiveLecture, { loading: archiving }] = useMutation(ARCHIVE_LECTURE_MUTATION);
  const [restoreLecture, { loading: restoring }] = useMutation(RESTORE_LECTURE_MUTATION);
  const [deleteLecture,  { loading: deleting }]  = useMutation(DELETE_LECTURE_MUTATION);
  const { data: askedData } = useQuery(GET_QUESTIONS_PER_LECTURE, { fetchPolicy: 'network-only' });
  const router = useRouter();
  const client = useApolloClient();

  const lecture: DBLecture | undefined = data?.lecture;

  const [chunkSearchInput, setChunkSearchInput] = useState('');
  const [chunkSearch,      setChunkSearch]      = useState('');
  const [chunkPage,        setChunkPage]        = useState(1);
  const CHUNK_PAGE_SIZE = 10;

  // Search runs on the server (question, answer, topic); wait for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => { setChunkSearch(chunkSearchInput.trim()); setChunkPage(1); }, 300);
    return () => clearTimeout(t);
  }, [chunkSearchInput]);

  // One page at a time (AD6) — the whole dataset with full answers is never downloaded.
  const { data: chunksData, loading: chunksLoading, refetch: refetchChunks } = useQuery<{
    lectureChunks: { items: QnaChunk[]; total: number; hasMore: boolean };
  }>(GET_LECTURE_CHUNKS, {
    variables: {
      lectureId: parseInt(params.id, 10),
      limit: CHUNK_PAGE_SIZE,
      offset: (chunkPage - 1) * CHUNK_PAGE_SIZE,
      search: chunkSearch || null,
    },
    fetchPolicy: 'network-only',
    skip: !data?.lecture || data.lecture.status !== 'READY',
  });
  const pagedChunks: QnaChunk[] = chunksData?.lectureChunks.items ?? [];
  const chunkTotal = chunksData?.lectureChunks.total ?? 0;
  const chunkPages = Math.max(1, Math.ceil(chunkTotal / CHUNK_PAGE_SIZE));

  const [editMode,   setEditMode]   = useState(false);
  const [editForm,   setEditForm]   = useState({ title: '', description: '', youtubeUrl: '' });
  const [editError,  setEditError]  = useState('');
  const [notice,     setNotice]     = useState('');
  const [removeError, setRemoveError] = useState('');
  const [pending,    setPending]    = useState<'archive' | 'delete' | null>(null);

  // Track actual embedding rate across polls: { count, timestamp }
  const prevProgressRef = useRef<{ count: number; ts: number } | null>(null);
  const [chunksPerSec, setChunksPerSec] = useState<number | null>(null);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    if (!lecture || !POLLING_STATUSES.has(lecture.status)) return;
    const id = setInterval(() => {
      refetch().then(({ data: d }) => {
        const s = d?.lecture?.status;
        const current = d?.lecture?.progressCurrent ?? 0;
        const now = Date.now();

        // Calculate real-time rate
        if (s === 'EMBEDDING' && current > 0) {
          if (prevProgressRef.current && current > prevProgressRef.current.count) {
            const deltaChunks = current - prevProgressRef.current.count;
            const deltaSecs   = (now - prevProgressRef.current.ts) / 1000;
            if (deltaSecs > 0) setChunksPerSec(deltaChunks / deltaSecs);
          }
          prevProgressRef.current = { count: current, ts: now };
        } else if (s !== 'EMBEDDING') {
          prevProgressRef.current = null;
          setChunksPerSec(null);
        }

        if (s && !POLLING_STATUSES.has(s)) clearInterval(id);
      });
    }, 3000);
    return () => clearInterval(id);
  }, [lecture?.status, refetch]); // eslint-disable-line react-hooks/exhaustive-deps

  const startEdit = () => {
    setEditForm({ title: lecture?.title ?? '', description: lecture?.description ?? '', youtubeUrl: lecture?.youtubeUrl ?? '' });
    setEditError('');
    setEditMode(true);
  };

  /** Students, the chat and the lecture list each hold their own copy. */
  const purgeLectureLists = () => {
    client.cache.evict({ id: 'ROOT_QUERY', fieldName: 'lectures' });
    client.cache.gc();
  };

  const runRemoval = async (action: 'archive' | 'restore' | 'delete') => {
    setRemoveError(''); setNotice('');
    try {
      if (action === 'archive') {
        await archiveLecture({ variables: { id: params.id } });
        setNotice('Archived. Students can no longer see this lecture.');
      } else if (action === 'restore') {
        await restoreLecture({ variables: { id: params.id } });
        setNotice('Restored. Students can see this lecture again.');
      } else {
        await deleteLecture({ variables: { id: params.id } });
        purgeLectureLists();
        router.push('/admin/lectures');
        return;
      }
      setPending(null);
      purgeLectureLists();
      await refetch();
    } catch (err) {
      setRemoveError((err as { graphQLErrors?: { message: string }[] })?.graphQLErrors?.[0]?.message ?? 'That action could not be completed.');
      setPending(null);
    }
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setEditError('');
    try {
      await updateLecture({
        variables: {
          id: params.id,
          input: {
            title:       editForm.title.trim()       || undefined,
            description: editForm.description.trim() || undefined,
            youtubeUrl:  editForm.youtubeUrl.trim()  || undefined,
          },
        },
      });
      setEditMode(false);
      refetch();
      setNotice('Lecture details updated.');
    } catch (err: unknown) {
      setEditError((err as { graphQLErrors?: { message: string }[] })?.graphQLErrors?.[0]?.message ?? 'Update failed.');
    }
  };

  if (loading) {
    return (
      <div className="max-w-[1180px]">
        <div className="h-24 rounded-card bg-[var(--card)] border border-[var(--border)] animate-pulse mb-5" />
        <div className="h-64 rounded-card bg-[var(--card)] border border-[var(--border)] animate-pulse" />
      </div>
    );
  }

  if (!lecture) {
    return (
      <div className="max-w-[1180px]">
        <div className="rounded-card border border-[var(--border)] bg-[var(--card)] p-10 text-center">
          <p className="text-label font-semibold text-[var(--text)]">Lecture not found</p>
          <p className="text-caption text-[var(--muted)] mt-1">It may have been deleted.</p>
          <Link href="/admin/lectures" className="mt-4 inline-block text-label font-semibold text-[var(--accent)] hover:underline">
            Back to Lectures
          </Link>
        </div>
      </div>
    );
  }

  const s = STATUS[lecture.status] ?? STATUS.NO_DATASET;
  const isPolling = POLLING_STATUSES.has(lecture.status);
  // Reused from Overview's query so the page can say how much history exists.
  const asked = (askedData?.questionsPerLecture ?? [])
    .find((q: { lectureId: number }) => q.lectureId === Number(lecture.id))?.count ?? 0;
  const removalBusy = archiving || restoring || deleting;
  const courses: DBCourse[] = courseData?.courses ?? [];
  const course = courses.find(c => c.id === lecture.courseId);

  // Real progress only. The old card drew four steps and marked the first two
  // finished without checking anything.
  const showProgress = lecture.status === 'EMBEDDING' && lecture.progressTotal > 0;
  const pct       = showProgress ? Math.round((lecture.progressCurrent / lecture.progressTotal) * 100) : 0;
  const remaining = showProgress ? lecture.progressTotal - lecture.progressCurrent : 0;
  const estSecs   = (lecture.status === 'EMBEDDING' && chunksPerSec && chunksPerSec > 0)
    ? Math.ceil(remaining / chunksPerSec) : null;
  const estLabel  = estSecs === null ? null
    : estSecs < 60 ? `about ${estSecs} seconds left`
    : `about ${Math.ceil(estSecs / 60)} minutes left`;

  return (
    <div className="max-w-[1180px]">
      {/* No Back button. That slot holds a page's main action on every other
          admin page, and the breadcrumb above already goes back. */}
      <AdminPageHero
        parent={{ label: 'Lectures', href: '/admin/lectures' }}
        title={lecture.title}
        subtitle={[
          course ? (course.archivedAt ? `${course.title} (archived)` : course.title) : 'Course unknown',
          new Date(lecture.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }),
        ].join(' · ')}
      />

      {notice && (
        <div role="status" className="mb-5 flex items-center gap-2.5 rounded-card border border-[var(--border)] border-l-[3px] border-l-[var(--accent)] bg-[var(--card)] px-5 py-3.5">
          <i className="fas fa-circle-check text-[13px] text-[var(--accent)]" aria-hidden="true" />
          <p className="text-label text-[var(--text)]">{notice}</p>
        </div>
      )}

      {/* State of the lecture, said once. The heading above no longer repeats
          it, and there is no coloured banner. */}
      <section className={`rounded-card border border-[var(--border)] bg-[var(--card)] px-5 py-4 mb-5 ${
        s.attention ? 'border-l-[3px] border-l-[var(--gold)]' : ''
      }`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className={`text-label font-semibold ${s.attention ? 'text-[var(--gold)]' : 'text-[var(--text)]'}`}>
              {lecture.archivedAt ? 'Archived' : s.label}
            </p>
            <p className="text-caption text-[var(--muted)] mt-0.5">
              {lecture.archivedAt ? 'Withdrawn from students. Restore it from the Lectures list.' : s.note}
            </p>
          </div>
          {/* No Refresh button. While anything is being built the page reloads
              itself every 3 seconds, and in every other state nothing can
              change on its own, so pressing it would do nothing. */}
          {isPolling && (
            <span className="shrink-0 text-caption text-[var(--muted)]">Updating automatically</span>
          )}
        </div>

        {showProgress && (
          <div className="mt-4">
            <div className="flex items-baseline justify-between gap-4 mb-1.5">
              <span className="text-caption text-[var(--muted)] tabular-nums">
                {lecture.progressCurrent} of {lecture.progressTotal} chunks
              </span>
              <span className="text-caption text-[var(--muted)] tabular-nums">
                {pct}%{estLabel ? ` · ${estLabel}` : ''}
              </span>
            </div>
            <div className="h-2 rounded-full bg-[var(--surface)] border border-[var(--border)] overflow-hidden">
              <div className="h-full rounded-full bg-[var(--accent)] transition-[width]" style={{ width: `${Math.max(pct, 2)}%` }} />
            </div>
          </div>
        )}
      </section>

      <section className="rounded-card border border-[var(--border)] bg-[var(--card)] p-6 mb-5">
        <div className="flex items-center justify-between gap-4 mb-5">
          <h2 className="text-h3 font-semibold text-[var(--text)]">Lecture Details</h2>
          {!editMode && <button onClick={startEdit} className={outlineBtn}>Edit Details</button>}
        </div>

        {editMode ? (
          <form onSubmit={handleUpdate} className="space-y-4">
            <label className="block text-caption font-semibold text-[var(--muted)]">
              Title
              <input value={editForm.title} onChange={e => setEditForm(f => ({ ...f, title: e.target.value }))} className={fieldClass + ' mt-2'} />
            </label>
            <label className="block text-caption font-semibold text-[var(--muted)]">
              YouTube URL
              <input value={editForm.youtubeUrl} onChange={e => setEditForm(f => ({ ...f, youtubeUrl: e.target.value }))} className={fieldClass + ' mt-2'} placeholder="Leave empty for a document-only lecture" />
            </label>
            <label className="block text-caption font-semibold text-[var(--muted)]">
              Description
              <textarea value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} rows={3} className={fieldClass + ' mt-2 resize-none'} />
            </label>

            {editError && <p role="alert" className="text-caption text-red-700">{editError}</p>}

            <div className="flex gap-2 pt-1">
              <button type="submit" disabled={updating} className="h-10 rounded-control bg-[var(--accent)] px-5 text-label font-semibold text-white hover:bg-[var(--accent-deep)] transition-colors disabled:opacity-50">
                {updating ? 'Saving…' : 'Save Changes'}
              </button>
              <button type="button" onClick={() => setEditMode(false)} className="h-10 rounded-control border border-[var(--border)] px-4 text-label font-semibold text-[var(--text)] hover:bg-[var(--surface)] transition-colors">
                Cancel
              </button>
            </div>
          </form>
        ) : (
          /* "Lecture ID #2" is gone: that was the database row number, which
             says nothing to the person reading it. */
          <dl className="space-y-4">
            <div>
              <dt className="text-caption text-[var(--muted)]">Course</dt>
              <dd className="text-label text-[var(--text)] mt-0.5">
                {course ? (
                  <Link href={`/admin/lectures?courseId=${encodeURIComponent(course.id)}`} className="font-medium text-[var(--accent)] hover:underline">
                    {course.title}
                  </Link>
                ) : 'Unknown'}
              </dd>
            </div>
            <div>
              <dt className="text-caption text-[var(--muted)]">Added</dt>
              <dd className="text-label text-[var(--text)] mt-0.5">
                {new Date(lecture.createdAt).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </dd>
            </div>
            <div>
              <dt className="text-caption text-[var(--muted)]">Video</dt>
              <dd className="text-label mt-0.5 break-all">
                {lecture.youtubeUrl
                  ? <a href={lecture.youtubeUrl} target="_blank" rel="noreferrer" className="font-medium text-[var(--accent)] hover:underline">{lecture.youtubeUrl}</a>
                  : <span className="text-[var(--muted)]">No video. This lecture is built from documents only.</span>}
              </dd>
            </div>
            {lecture.description && (
              <div>
                <dt className="text-caption text-[var(--muted)]">Description</dt>
                <dd className="text-label text-[var(--text)] mt-0.5 leading-relaxed max-w-[70ch]">{lecture.description}</dd>
              </div>
            )}
          </dl>
        )}
      </section>

      {/* Upload, preview, build progress, export, versions and rollback.
          Kiran's component; left as it is. */}
      <DatasetManager
        lectureId={parseInt(params.id, 10)}
        lectureStatus={lecture.status}
        onChanged={() => { void refetch(); void refetchChunks(); }}
      />

      {lecture.status === 'READY' && (
        <section className="rounded-card border border-[var(--border)] bg-[var(--card)] p-6 mt-5">
          <div className="flex flex-wrap items-baseline justify-between gap-3 mb-4">
            <div>
              <h2 className="text-h3 font-semibold text-[var(--text)]">Dataset Contents</h2>
              <p className="text-caption text-[var(--muted)] mt-0.5">
                The question and answer pairs the tutor answers from.
              </p>
            </div>
            {chunkTotal > 0 && (
              <span className="text-caption text-[var(--muted)] tabular-nums shrink-0">
                {chunkTotal} {chunkTotal === 1 ? 'pair' : 'pairs'}{chunkSearch ? ' matching' : ''}
              </span>
            )}
          </div>

          <div className="relative mb-4">
            <i className="fas fa-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-[13px] text-[var(--muted2)]" aria-hidden="true" />
            <input
              value={chunkSearchInput}
              onChange={e => setChunkSearchInput(e.target.value)}
              placeholder="Search questions, answers or topics"
              className="w-full rounded-control border border-[var(--border)] bg-[var(--card)] pl-10 pr-4 py-2.5 text-label text-[var(--text)] outline-none transition-colors focus:border-[var(--muted)] placeholder:text-[var(--muted2)]"
            />
          </div>

          {chunksLoading && !chunksData ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => <div key={i} className="h-16 rounded-control bg-[var(--surface)] animate-pulse" />)}
            </div>
          ) : pagedChunks.length === 0 ? (
            <p className="py-10 text-center text-label text-[var(--muted)]">
              {chunkSearch ? 'Nothing matches that search.' : 'This dataset has no pairs.'}
            </p>
          ) : (
            <ul className="space-y-5">
              {pagedChunks.map(chunk => (
                <li key={chunk.id}>
                  {chunk.topic && (
                    <p className="text-caption text-[var(--muted)] mb-1">{chunk.topic}</p>
                  )}
                  <p className="text-label font-semibold text-[var(--text)]">{chunk.question}</p>
                  <p className="text-label text-[var(--muted)] mt-1 leading-relaxed line-clamp-3">{chunk.answer}</p>
                </li>
              ))}
            </ul>
          )}

          {chunkPages > 1 && (
            <div className="flex items-center justify-between gap-4 mt-5 pt-4 border-t border-[var(--border)]">
              <span className="text-caption text-[var(--muted)] tabular-nums">Page {chunkPage} of {chunkPages}</span>
              <div className="flex gap-2">
                <button onClick={() => setChunkPage(p => Math.max(1, p - 1))} disabled={chunkPage === 1} className={outlineBtn}>
                  Previous
                </button>
                <button onClick={() => setChunkPage(p => Math.min(chunkPages, p + 1))} disabled={chunkPage === chunkPages} className={outlineBtn}>
                  Next
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Withdrawing a lecture was only possible from the list page. An admin
          looking at the lecture had no way to act on it. */}
      <section className="rounded-card border border-[var(--border)] bg-[var(--card)] p-6 mt-5">
        <h2 className="text-h3 font-semibold text-[var(--text)]">Availability</h2>
        <p className="text-caption text-[var(--muted)] mt-0.5">
          {lecture.archivedAt
            ? 'This lecture is withdrawn from students.'
            : asked > 0
              ? `Students have asked ${asked} ${asked === 1 ? 'question' : 'questions'} about this lecture.`
              : 'No questions have been asked about this lecture yet.'}
        </p>

        {removeError && (
          <p role="alert" className="mt-3 flex items-start gap-2 text-label text-[var(--text)]">
            <i className="fas fa-triangle-exclamation text-[13px] text-[var(--gold)] mt-1 shrink-0" aria-hidden="true" />
            {removeError}
          </p>
        )}

        {pending ? (
          <div className="mt-4">
            <p className="text-label text-[var(--text)]">
              {pending === 'archive'
                ? 'Students lose access. Nothing is deleted, and you can restore it.'
                : 'Removes its dataset and chat history for good. Cannot be undone.'}
            </p>
            <div className="flex flex-wrap gap-2 mt-3">
              <button
                type="button"
                disabled={removalBusy}
                onClick={() => void runRemoval(pending)}
                className="rounded-control bg-[var(--accent)] px-3.5 py-2 text-caption font-semibold text-white hover:bg-[var(--accent-deep)] transition-colors disabled:opacity-50"
              >
                {removalBusy ? 'Working…' : pending === 'archive' ? 'Archive Lecture' : 'Delete Permanently'}
              </button>
              <button type="button" onClick={() => setPending(null)} className={outlineBtn}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2 mt-4">
            {lecture.archivedAt ? (
              <button type="button" disabled={removalBusy} onClick={() => void runRemoval('restore')} className={outlineBtn}>
                Restore
              </button>
            ) : (
              <button type="button" onClick={() => setPending('archive')} className={outlineBtn}>
                Archive
              </button>
            )}
            {asked === 0 && (
              <button type="button" onClick={() => setPending('delete')} className={outlineBtn}>
                Delete
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
