'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useApolloClient, useMutation, useQuery } from '@apollo/client';
import {
  ARCHIVE_COURSE, CREATE_COURSE, DELETE_COURSE, GET_COURSES, RESTORE_COURSE, UPDATE_COURSE,
} from '@/graphql/course.queries';
import { DBCourse } from '@/types/course';
import { AdminPageHero } from '@/components/admin/AdminPageHero';

const inputStyle = 'w-full rounded-control border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-label text-[var(--text)] outline-none transition-colors focus:border-[var(--muted)]';
const outlineBtn = 'rounded-control border border-[var(--border)] px-3.5 py-2 text-caption font-semibold text-[var(--text)] hover:bg-[var(--surface)] transition-colors';
const initial = { title: '', subtitle: '', description: '' };

type Pending = { id: string; action: 'archive' | 'delete' } | null;

/**
 * Courses.
 *
 * Removing a course is not a delete. Its lectures carry datasets and chunks,
 * and every question a student asked is recorded against them, so withdrawing
 * a course that has been taught means archiving it: it stops being listed and
 * stops being offered as a home for new lectures, and everything it owns stays
 * where it is. Restore undoes it. Deletion is offered only for a course that
 * has no lectures at all, which is the one case where nothing is lost.
 */
export default function AdminCoursesPage() {
  // Only this page asks for archived courses, and the resolver grants that to
  // admins alone; every other caller gets active courses.
  const { data, loading, error, refetch } = useQuery(GET_COURSES, {
    variables: { includeArchived: true },
    fetchPolicy: 'network-only',
  });
  const [createCourse,  { loading: creating }]   = useMutation(CREATE_COURSE);
  const [updateCourse,  { loading: updating }]   = useMutation(UPDATE_COURSE);
  const [archiveCourse, { loading: archiving }]  = useMutation(ARCHIVE_COURSE);
  const [restoreCourse, { loading: restoring }]  = useMutation(RESTORE_COURSE);
  const [deleteCourse,  { loading: deleting }]   = useMutation(DELETE_COURSE);

  const [form, setForm] = useState(initial);
  const [editId, setEditId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
  const [formError, setFormError] = useState('');
  const [pending, setPending] = useState<Pending>(null);
  const panelRef = useRef<HTMLElement>(null);
  const client = useApolloClient();

  /**
   * Other pages hold their own copy of the course list: the student Courses
   * page, Lectures, and the course picker on Add Lecture. Refetching this
   * page's query does not touch theirs, so a course archived here would still
   * be offered there until the next full reload. Dropping the field from the
   * cache makes every one of them fetch again.
   */
  const purgeCourseLists = () => {
    client.cache.evict({ id: 'ROOT_QUERY', fieldName: 'courses' });
    client.cache.gc();
  };

  const all: DBCourse[] = data?.courses ?? [];
  const active   = all.filter(c => !c.archivedAt);
  const archived = all.filter(c => c.archivedAt);
  const editing  = all.find(c => c.id === editId);
  const busy = archiving || restoring || deleting;

  // The confirmation had no timer of any kind: it stayed until the next action
  // or until the page was left and reopened.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const openCreate = () => {
    setEditId(null); setForm(initial);
    setFormError(''); setNotice(''); setActionError(null);
    setPanelOpen(true);
  };
  const startEdit = (course: DBCourse) => {
    setEditId(course.id);
    setForm({ title: course.title, subtitle: course.subtitle, description: course.description });
    setFormError(''); setNotice(''); setActionError(null);
    setPanelOpen(true);
    panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const close = () => {
    setPanelOpen(false); setEditId(null); setForm(initial); setFormError('');
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(''); setNotice('');
    if (!form.title.trim()) { setFormError('Course title is required.'); return; }
    try {
      const input = { title: form.title.trim(), subtitle: form.subtitle.trim(), description: form.description.trim() };
      if (editId) {
        await updateCourse({ variables: { id: editId, input } });
        setNotice('Course updated.');
      } else {
        await createCourse({ variables: { input } });
        // The list is ordered oldest first, so a new course is added at the end.
        setNotice('Course created. It has been added at the end of the list.');
      }
      close();
      purgeCourseLists();
      await refetch();
    } catch (err) {
      setFormError((err as {graphQLErrors?: {message:string}[]})?.graphQLErrors?.[0]?.message ?? 'Could not save course.');
    }
  };

  const run = async (course: DBCourse, action: 'archive' | 'delete' | 'restore') => {
    setActionError(null); setNotice('');
    try {
      if (action === 'archive') {
        await archiveCourse({ variables: { id: course.id } });
        setNotice(`${course.title} has been archived. Its lectures and question history are unchanged.`);
      } else if (action === 'restore') {
        await restoreCourse({ variables: { id: course.id } });
        setNotice(`${course.title} is active again.`);
      } else {
        await deleteCourse({ variables: { id: course.id } });
        setNotice(`${course.title} has been deleted.`);
      }
      setPending(null);
      if (editId === course.id) close();
      purgeCourseLists();
      await refetch();
    } catch (err) {
      // Shown inside the course's own card, where the button was pressed: a
      // band across the top of the page read as a section heading rather than
      // as the result of an action.
      setActionError({
        id: course.id,
        message: (err as {graphQLErrors?: {message:string}[]})?.graphQLErrors?.[0]?.message ?? 'That action could not be completed.',
      });
      setPending(null);
    }
  };

  const card = (course: DBCourse, isArchived: boolean) => {
    const isEditing  = course.id === editId;
    const confirming = pending?.id === course.id ? pending.action : null;
    const canDelete  = course.lectureCount === 0;
    const failed     = actionError?.id === course.id ? actionError.message : null;

    return (
      <div
        key={course.id}
        className={`rounded-card border border-[var(--border)] bg-[var(--card)] p-5 ${
          isEditing ? 'border-l-[3px] border-l-[var(--accent)]' : ''
        }`}
      >
        {/* A course title is the heading of its card, so it is set at heading
            size rather than at body size. */}
        <h2 className="text-h3 font-semibold text-[var(--text)]">{course.title}</h2>

        {course.subtitle && <p className="text-label text-[var(--muted)] mt-1">{course.subtitle}</p>}
        {course.description && <p className="text-caption text-[var(--muted)] mt-2 leading-relaxed">{course.description}</p>}

        {/* Worded exactly as Overview words the same two numbers. */}
        <p className="text-caption text-[var(--muted)] mt-3">
          {course.lectureCount === 0
            ? 'No lectures yet'
            : `${course.lectureCount} ${course.lectureCount === 1 ? 'lecture' : 'lectures'} · ${course.readyCount} with a tutor ready`}
        </p>

        {failed && (
          <p role="alert" className="mt-3 flex items-start gap-2 text-label text-[var(--text)]">
            <i className="fas fa-triangle-exclamation text-[13px] text-[var(--gold)] mt-1 shrink-0" aria-hidden="true" />
            {failed}
          </p>
        )}

        {confirming ? (
          /* Asked inside the card, so the course being acted on is the one you
             are looking at. */
          <div className="mt-4 pt-4 border-t border-[var(--border)]">
            <p className="text-label text-[var(--text)]">
              {confirming === 'archive'
                ? 'Students lose access. Its lectures and questions are kept, and you can restore it.'
                : 'This course has no lectures. Deleting it cannot be undone.'}
            </p>
            <div className="flex flex-wrap gap-2 mt-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(course, confirming)}
                className="rounded-control bg-[var(--accent)] px-3.5 py-2 text-caption font-semibold text-white hover:bg-[var(--accent-deep)] transition-colors disabled:opacity-50"
              >
                {busy ? 'Working…' : confirming === 'archive' ? 'Archive Course' : 'Delete Permanently'}
              </button>
              <button type="button" onClick={() => setPending(null)} className={outlineBtn}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 mt-4 pt-4 border-t border-[var(--border)]">
            {isArchived ? (
              <>
                <button type="button" disabled={busy} onClick={() => void run(course, 'restore')} className={outlineBtn}>
                  Restore
                </button>
                {canDelete && (
                  <button type="button" onClick={() => setPending({ id: course.id, action: 'delete' })} className={outlineBtn}>
                    Delete
                  </button>
                )}
              </>
            ) : (
              <>
                <Link href={`/admin/lectures?courseId=${encodeURIComponent(course.id)}`} className={outlineBtn}>
                  View Lectures
                </Link>
                <Link href={`/admin/lectures/create?courseId=${encodeURIComponent(course.id)}`} className={outlineBtn}>
                  Add Lecture
                </Link>
                <button type="button" onClick={() => startEdit(course)} className={outlineBtn}>
                  Edit Details
                </button>
                {/* Archive is always offered: it is the safe action, and a
                    course with no lectures may still be one you only want
                    withdrawn. Delete is the extra, and only where there are no
                    lectures to lose. */}
                <button type="button" onClick={() => setPending({ id: course.id, action: 'archive' })} className={outlineBtn}>
                  Archive
                </button>
                {canDelete && (
                  <button type="button" onClick={() => setPending({ id: course.id, action: 'delete' })} className={outlineBtn}>
                    Delete
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="max-w-[1180px]">
      <AdminPageHero
        title="Courses"
        subtitle="Create a course, then add its lectures and material."
        action={
          <button
            type="button"
            onClick={openCreate}
            className="h-10 inline-flex items-center gap-2 rounded-control bg-[var(--accent)] px-5 text-label font-semibold text-white hover:bg-[var(--accent-deep)] transition-colors"
          >
            <i className="fas fa-plus text-[12px]" aria-hidden="true" />
            New Course
          </button>
        }
      />

      {/* Same panel shape as Needs Attention on Overview: white card, accent
          left edge, one icon. Feedback from an action is styled like the rest
          of the product rather than as a pale blue band of its own. */}
      {notice && (
        <div role="status" className="mb-5 flex items-center gap-2.5 rounded-card border border-[var(--border)] border-l-[3px] border-l-[var(--accent)] bg-[var(--card)] px-5 py-3.5">
          <i className="fas fa-circle-check text-[13px] text-[var(--accent)]" aria-hidden="true" />
          <p className="text-label text-[var(--text)]">{notice}</p>
        </div>
      )}

      <div className={panelOpen ? 'grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] gap-6 items-start' : ''}>
        <section>
          {loading ? (
            <p className="text-label text-[var(--muted)]">Loading courses…</p>
          ) : error ? (
            <div role="alert" className="rounded-card border border-[var(--border)] bg-[var(--card)] p-6">
              <p className="text-label text-red-700">Courses could not be loaded.</p>
              <button onClick={() => void refetch()} className="mt-3 text-label font-semibold text-[var(--accent)] hover:underline">Try again</button>
            </div>
          ) : all.length === 0 ? (
            <div className="rounded-card border border-[var(--border)] bg-[var(--card)] p-8 text-center">
              <p className="text-label font-semibold text-[var(--text)]">No courses yet</p>
              <p className="text-caption text-[var(--muted)] mt-1">Use New Course to add your first one.</p>
            </div>
          ) : (
            <>
              <div className="space-y-3">
                {active.map(c => card(c, false))}
              </div>

              {archived.length > 0 && (
                <div className="mt-8">
                  <h2 className="text-h3 font-semibold text-[var(--text)]">Archived</h2>
                  <p className="text-caption text-[var(--muted)] mt-0.5 mb-3">
                    Not shown to students and not offered when adding a lecture. Everything they hold is kept.
                  </p>
                  <div className="space-y-3">
                    {archived.map(c => card(c, true))}
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        {panelOpen && (
          <section ref={panelRef} className="rounded-card border border-[var(--border)] bg-[var(--card)] p-6 lg:sticky lg:top-8">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-h3 font-semibold text-[var(--text)]">{editId ? 'Edit Course' : 'Create Course'}</h2>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="shrink-0 -mr-1 -mt-1 w-8 h-8 rounded-control text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--text)] transition-colors"
              >
                <i className="fas fa-xmark text-[13px]" aria-hidden="true" />
              </button>
            </div>
            {/* The panel says which course it is editing. */}
            <p className="text-caption text-[var(--muted)] mt-1 mb-5">
              {editing ? `Editing ${editing.title}` : 'Each course keeps its own lectures and uploaded material.'}
            </p>

            <form onSubmit={save} className="space-y-4">
              <label className="block text-caption font-semibold text-[var(--muted)]">
                Course Title <span className="font-normal text-[var(--muted2)]">(required)</span>
                <input value={form.title} onChange={e => setForm({...form,title:e.target.value})} maxLength={160} required className={inputStyle + ' mt-2'} placeholder="e.g. Python Programming" />
              </label>
              <label className="block text-caption font-semibold text-[var(--muted)]">
                Subtitle
                <input value={form.subtitle} onChange={e => setForm({...form,subtitle:e.target.value})} maxLength={240} className={inputStyle + ' mt-2'} placeholder="One line describing the course" />
              </label>
              <label className="block text-caption font-semibold text-[var(--muted)]">
                Description
                <textarea value={form.description} onChange={e => setForm({...form,description:e.target.value})} maxLength={2000} rows={4} className={inputStyle + ' mt-2 resize-none'} placeholder="What the course covers" />
              </label>

              {formError && <p role="alert" className="text-caption text-red-700">{formError}</p>}

              <div className="flex gap-2 pt-1">
                <button type="submit" disabled={creating || updating} className="h-10 rounded-control bg-[var(--accent)] px-5 text-label font-semibold text-white hover:bg-[var(--accent-deep)] transition-colors disabled:opacity-50">
                  {creating || updating ? 'Saving…' : editId ? 'Save Changes' : 'Create Course'}
                </button>
                <button type="button" onClick={close} className="h-10 rounded-control border border-[var(--border)] px-4 text-label font-semibold text-[var(--text)] hover:bg-[var(--surface)] transition-colors">
                  Cancel
                </button>
              </div>
            </form>
          </section>
        )}
      </div>
    </div>
  );
}
