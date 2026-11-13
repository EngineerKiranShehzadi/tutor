'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@apollo/client';
import { GET_COURSES } from '@/graphql/course.queries';
import { DBCourse } from '@/types/course';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useMutation } from '@apollo/client';
import { CREATE_LECTURE_MUTATION } from '@/graphql/lecture.queries';

const FIELD_CLASS = 'w-full px-4 py-2.5 bg-[var(--surface)] border border-[var(--border)] rounded-card text-label text-[var(--text)] outline-none focus:border-[var(--accent)] focus:bg-[var(--card)] transition-colors placeholder:text-[var(--muted2)]';

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
      setError('AI agent name and instructions are required.');
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
    <div className="max-w-2xl">
      {/* Back + title */}
      <div className="flex items-center gap-3 mb-7">
        <Link
          href="/admin/lectures"
          className="w-8 h-8 rounded-card bg-[var(--card)] border border-[var(--border)] flex items-center justify-center text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--muted2)] transition-colors"
        >
          <i className="fas fa-arrow-left text-caption" />
        </Link>
        <div>
          <h1 className="text-h2 font-semibold text-[var(--text)]">New Lecture</h1>
          <p className="text-label text-[var(--muted)]">Add a lecture and upload a dataset to activate AI tutoring.</p>
        </div>
      </div>

      <div className="bg-[var(--card)] rounded-card border border-[var(--border)] overflow-hidden">
        {/* Form header */}
        <div className="px-6 py-4 border-b border-[var(--border)] bg-[var(--surface)] flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-card bg-[var(--accent)] flex items-center justify-center">
            <i className="fas fa-film text-white text-[11px]" />
          </div>
          <span className="text-label font-semibold text-[var(--text)]">Lecture Details</span>
        </div>

        <form onSubmit={handleSubmit} className="p-6 flex flex-col gap-5">
          {/* Course */}
          <div>
            <label className="block text-caption font-semibold text-[var(--muted)] mb-2">
              Course <span className="text-[var(--gold)] normal-case">*</span>
            </label>
            <select
              value={courseId}
              onChange={e => setCourseId(e.target.value)}
              disabled={coursesLoading}
              required
              className={FIELD_CLASS}
            >
              <option value="">Select course</option>
              {courses.map(course => <option key={course.id} value={course.id}>{course.title}</option>)}
            </select>
            {coursesError && <p className="text-[var(--gold)] text-caption mt-1">Could not load courses.</p>}
            <Link href="/admin/courses" className="text-caption text-[var(--accent)] hover:underline inline-block mt-2">Create or manage courses</Link>
          </div>
          {/* Title */}
          <div>
            <label className="block text-caption font-semibold text-[var(--muted)] mb-2">
              Title <span className="text-[var(--gold)] normal-case">*</span>
            </label>
            <input
              type="text"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="e.g. Lecture 1 — Introduction to Islamic Studies"
              className={FIELD_CLASS}
            />
          </div>

          {/* YouTube URL */}
          <div>
            <label className="block text-caption font-semibold text-[var(--muted)] mb-2">
              YouTube URL <span className="text-[var(--muted2)] normal-case font-normal">(optional for document-only lectures)</span>
            </label>
            <div className="relative">
              <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--muted2)]">
                <i className="fab fa-youtube text-[var(--gold)] text-label" />
              </div>
              <input
                type="url"
                value={form.youtubeUrl}
                onChange={(e) => setForm((f) => ({ ...f, youtubeUrl: e.target.value }))}
                placeholder="https://www.youtube.com/watch?v=..."
                className={`${FIELD_CLASS} pl-10`}
              />
            </div>
            <p className="text-[11px] text-[var(--muted2)] mt-1.5">
              Optional. Add a YouTube video or create a lecture using PDF, Word, PowerPoint, TXT or HTML materials.
            </p>
          </div>

          {/* Description */}
          <div>
            <label className="block text-caption font-semibold text-[var(--muted)] mb-2">
              Description <span className="text-[var(--muted2)] normal-case font-normal">(optional)</span>
            </label>
            <textarea
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Brief description of lecture content for students…"
              rows={3}
              className={`${FIELD_CLASS} resize-none`}
            />
          </div>

          {/* AI agent */}
          <div className="pt-2 border-t border-[var(--border)]">
            <p className="text-caption font-semibold text-[var(--muted)] mb-4">AI Agent for this lecture</p>
            <div className="flex flex-col gap-5">
              <div>
                <label className="block text-caption font-semibold text-[var(--muted)] mb-2">
                  Agent Name <span className="text-[var(--gold)] normal-case">*</span>
                </label>
                <input
                  type="text"
                  value={form.agentName}
                  onChange={(e) => setForm((f) => ({ ...f, agentName: e.target.value }))}
                  placeholder="e.g. Nova"
                  className={FIELD_CLASS}
                />
              </div>
              <div>
                <label className="block text-caption font-semibold text-[var(--muted)] mb-2">
                  Agent Instructions <span className="text-[var(--gold)] normal-case">*</span>
                </label>
                <textarea
                  value={form.agentInstructions}
                  onChange={(e) => setForm((f) => ({ ...f, agentInstructions: e.target.value }))}
                  placeholder="Describe this lecture's scope and how the agent should present answers…"
                  rows={5}
                  maxLength={4000}
                  className={`${FIELD_CLASS} resize-none`}
                />
                <p className="text-[11px] text-[var(--muted2)] mt-1.5">
                  {form.agentInstructions.length} / 4000 · The agent goes live once the dataset is uploaded and READY.
                </p>
              </div>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2.5 bg-[var(--gold-soft)] border border-[var(--border)] rounded-card px-4 py-3 text-label text-[var(--gold)]">
              <i className="fas fa-circle-exclamation mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-2 border-t border-[var(--border)]">
            <button
              type="submit"
              disabled={loading || coursesLoading || !courseId}
              className="flex items-center gap-2 px-5 py-2.5 bg-[var(--accent)] text-white rounded-card text-caption font-semibold hover:bg-[var(--accent-deep)] disabled:opacity-60 transition-colors"
            >
              {loading ? (
                <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Creating…</>
              ) : (
                <><i className="fas fa-plus text-[11px]" /> Create Lecture</>
              )}
            </button>
            <Link
              href="/admin/lectures"
              className="px-5 py-2.5 border border-[var(--border)] rounded-card text-caption font-semibold text-[var(--muted)] hover:bg-[var(--surface)] transition-colors"
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>

      {/* Info note */}
      <div className="mt-4 flex items-start gap-2.5 px-4 py-3 bg-[var(--accent-soft)] border border-[var(--border)] rounded-card">
        <i className="fas fa-circle-info text-[var(--accent)] mt-0.5 shrink-0" />
        <p className="text-caption text-[var(--accent)] leading-relaxed">
          After creating the lecture, you&apos;ll be taken to the detail page where you can upload Excel, PDF, DOCX, PPTX, TXT or HTML learning material to activate the AI tutor.
        </p>
      </div>
    </div>
  );
}
