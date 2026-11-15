'use client';
import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@apollo/client';
import { GET_COURSES } from '@/graphql/course.queries';
import { DBCourse } from '@/types/course';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { CREATE_LECTURE_MUTATION } from '@/graphql/lecture.queries';
import { AdminPageHero } from '@/components/admin/AdminPageHero';
import { btnPrimary, btnRow } from '@/components/admin/buttons';

const FIELD_CLASS = 'w-full h-10 px-3 bg-[var(--surface)] border border-[var(--border)] rounded-control text-label text-[var(--text)] outline-none focus:border-[var(--accent)] focus:bg-[var(--card)] transition-colors placeholder:text-[var(--muted2)]';
const AREA_CLASS = 'w-full px-3 py-2 bg-[var(--surface)] border border-[var(--border)] rounded-control text-label text-[var(--text)] outline-none focus:border-[var(--accent)] focus:bg-[var(--card)] transition-colors placeholder:text-[var(--muted2)] resize-none';

// The formats the dataset pipeline accepts, stated once. The page used to
// carry two lists of these, in two places, and they disagreed: the hint under
// the video field left out Excel, the format the pipeline was built around.
const MATERIAL_FORMATS = 'Excel, PDF, Word, PowerPoint, text or HTML';

/**
 * One rule for every label: required fields carry a muted asterisk, optional
 * ones say "Optional". Gold is the colour this admin uses for something
 * needing attention, and a field being required is not that.
 *
 * `span` is the grid width. Short values sit two to a row; anything someone
 * writes a sentence into takes the full row.
 */
function Field({ id, label, required, hint, span = 1, children }: {
  id: string; label: string; required?: boolean; hint?: string; span?: 1 | 2; children: React.ReactNode;
}) {
  return (
    <div className={span === 2 ? 'sm:col-span-2' : ''}>
      {/* Lighter than the fieldLabel token used for table column headings. A
          column heading labels a whole column of values and earns the weight;
          a form label sits directly above its own field and reads as shouting
          at this size. Optional is bracketed so it reads as an aside rather
          than part of the field name. */}
      <label htmlFor={id} className="block mb-1.5">
        <span className="text-[12px] font-normal text-[var(--muted)]">{label}</span>
        <span className="text-[12px] font-normal text-[var(--muted2)]">{required ? ' *' : ' (optional)'}</span>
      </label>
      {children}
      {hint && <p className="text-caption text-[var(--muted2)] mt-1.5 leading-relaxed">{hint}</p>}
    </div>
  );
}

export default function CreateLecturePage() {
  const router = useRouter();
  const [form, setForm] = useState({ title: '', description: '', youtubeUrl: '', agentName: '', agentInstructions: '' });
  const [error, setError] = useState('');
  const [courseId, setCourseId] = useState('');
  const { data: coursesData, loading: coursesLoading, error: coursesError } = useQuery(GET_COURSES);
  const courses: DBCourse[] = coursesData?.courses ?? [];
  useEffect(() => {
    const selected = new URLSearchParams(window.location.search).get('courseId');
    if (selected) setCourseId(selected);
  }, []);
  useEffect(() => {
    if (!courseId && courses.length) setCourseId(courses[0].id);
  }, [courses, courseId]);

  const [createLecture, { loading }] = useMutation(CREATE_LECTURE_MUTATION);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!form.title.trim()) {
      setError('Lecture title is required.');
      return;
    }
    if (!courseId || !courses.some(c => c.id === courseId)) { setError('Choose a valid course first.'); return; }
    if (!form.agentName.trim() || !form.agentInstructions.trim()) {
      setError('Tutor name and instructions are required.');
      return;
    }
    try {
      const { data } = await createLecture({
        variables: {
          input: {
            title:       form.title.trim(),
            courseId: Number(courseId),
            description: form.description.trim() || undefined,
            youtubeUrl:  form.youtubeUrl.trim() || undefined,
            agentName:         form.agentName.trim(),
            agentInstructions: form.agentInstructions.trim(),
          },
        },
      });
      const newId = data?.createLecture?.id;
      console.log(`[ADMIN] ✅ Lecture created: #${newId} "${form.title}"`);
      router.push(`/admin/lectures/${newId}`);
    } catch (err: unknown) {
      const msg = (err as { graphQLErrors?: { message: string }[] })?.graphQLErrors?.[0]?.message ?? 'Failed to create lecture.';
      console.error('[ADMIN] ❌ Create lecture failed:', msg);
      setError(msg);
    }
  };

  return (
    /* 640px, not the full width of the screen. Six fields do not need
       780px-wide inputs: a Title that long is harder to read, not easier,
       and stretching them was what made this page look empty on the right. */
    <div className="max-w-[640px]">
      <AdminPageHero
        title="New Lecture"
        subtitle="Add a lecture, then upload its material to start the tutor."
        parent={{ label: 'Lectures', href: '/admin/lectures' }}
      />

      <form onSubmit={handleSubmit} className="bg-[var(--card)] rounded-card border border-[var(--border)] p-6">
        {/* Two to a row for the short values, full row for anything with a
            sentence in it. Half the height of a single stacked column, and
            the width is used rather than padded out. */}
        {/* Both groups carry a heading. One section titled and the other not
            read as the first group having lost its label. */}
        <div className="grid sm:grid-cols-2 gap-x-4 gap-y-4">
          <h2 className="sm:col-span-2 text-label font-semibold text-[var(--text)]">Lecture</h2>

          <Field id="course" label="Course" required span={2}>
            <select
              id="course"
              value={courseId}
              onChange={e => setCourseId(e.target.value)}
              disabled={coursesLoading}
              required
              /* select-arrow insets the chevron. A native select puts it hard
                 against the border, which is the thing we fixed elsewhere. */
              className={`${FIELD_CLASS} select-arrow pr-9 cursor-pointer`}
            >
              <option value="">Select course</option>
              {courses.map(course => <option key={course.id} value={course.id}>{course.title}</option>)}
            </select>
            {coursesError && <p className="text-caption text-[var(--gold)] mt-1.5">Could not load courses.</p>}
          </Field>

          <Field id="title" label="Title" required span={2}>
            <input
              id="title"
              type="text"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="e.g. Lecture 1 — Introduction"
              className={FIELD_CLASS}
            />
          </Field>

          <Field
            id="youtubeUrl"
            label="YouTube URL"
            span={2}
            hint={`Leave empty for a lecture built from ${MATERIAL_FORMATS} material.`}
          >
            <input
              id="youtubeUrl"
              type="url"
              value={form.youtubeUrl}
              onChange={(e) => setForm((f) => ({ ...f, youtubeUrl: e.target.value }))}
              placeholder="https://www.youtube.com/watch?v=…"
              className={FIELD_CLASS}
            />
          </Field>

          <Field id="description" label="Description" span={2}>
            <textarea
              id="description"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Shown to students before they open the lecture…"
              rows={2}
              className={AREA_CLASS}
            />
          </Field>
        </div>

        {/* No rule above this group. The heading and the space already say a
            new section has started, and a full-width line directly under a
            textarea read as the textarea having a second border. */}
        <div className="mt-5 grid sm:grid-cols-2 gap-x-4 gap-y-4">
          <h2 className="sm:col-span-2 text-label font-semibold text-[var(--text)]">Tutor</h2>

          <Field id="agentName" label="Tutor name" required span={2}>
            <input
              id="agentName"
              type="text"
              value={form.agentName}
              onChange={(e) => setForm((f) => ({ ...f, agentName: e.target.value }))}
              placeholder="e.g. Nova"
              className={FIELD_CLASS}
            />
          </Field>

          <Field
            id="agentInstructions"
            label="Tutor instructions"
            required
            span={2}
            /* Says what to write, in the admin's terms, rather than describing
               the prompt machinery. The counter appears once there is
               something to count: "0 / 4000" on an empty form is noise. */
            hint={'Sets tone, depth and emphasis. Answers still come only from the lecture material.'
              + (form.agentInstructions.length ? ` · ${form.agentInstructions.length} / 4000` : '')}
          >
            <textarea
              id="agentInstructions"
              value={form.agentInstructions}
              onChange={(e) => setForm((f) => ({ ...f, agentInstructions: e.target.value }))}
              placeholder="e.g. Explain for first-year students. Define every term before using it. Prefer short worked examples."
              rows={4}
              maxLength={4000}
              className={AREA_CLASS}
            />
          </Field>
        </div>

        {error && (
          <div role="alert" className="mt-5 flex items-start gap-2.5 bg-[var(--gold-soft)] rounded-control px-3.5 py-2.5 text-caption text-[var(--gold)]">
            <i className="fas fa-circle-exclamation mt-0.5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        <div className="mt-5 pt-5 border-t border-[var(--border)] flex items-center gap-3">
          <button type="submit" disabled={loading || coursesLoading || !courseId} className={btnPrimary}>
            {loading ? 'Creating…' : 'Create lecture'}
          </button>
          <Link href="/admin/lectures" className={btnRow}>Cancel</Link>
          <Link href="/admin/courses" className="ml-auto text-caption text-[var(--accent)] hover:underline">
            Manage courses
          </Link>
        </div>
      </form>
    </div>
  );
}
