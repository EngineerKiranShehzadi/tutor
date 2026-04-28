'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useMutation } from '@apollo/client';
import { CREATE_LECTURE_MUTATION } from '@/graphql/lecture.queries';

const FIELD_CLASS = 'w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-800 outline-none focus:border-indigo-500 focus:bg-white focus:ring-2 focus:ring-indigo-100 transition-all placeholder:text-slate-400';

export default function CreateLecturePage() {
  const router = useRouter();
  const [form, setForm] = useState({ title: '', description: '', youtubeUrl: '' });
  const [error, setError] = useState('');

  const [createLecture, { loading }] = useMutation(CREATE_LECTURE_MUTATION);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!form.title.trim() || !form.youtubeUrl.trim()) {
      setError('Title and YouTube URL are required.');
      return;
    }
    try {
      const { data } = await createLecture({
        variables: {
          input: {
            title:       form.title.trim(),
            description: form.description.trim() || undefined,
            youtubeUrl:  form.youtubeUrl.trim(),
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
          className="w-8 h-8 rounded-lg bg-white border border-slate-200 shadow-sm flex items-center justify-center text-slate-500 hover:text-slate-800 hover:border-slate-300 transition-colors"
        >
          <i className="fas fa-arrow-left text-[12px]" />
        </Link>
        <div>
          <h1 className="text-[22px] font-bold text-slate-900">New Lecture</h1>
          <p className="text-sm text-slate-500">Add a lecture and upload a dataset to activate AI tutoring.</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        {/* Form header */}
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/60 flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center">
            <i className="fas fa-film text-white text-[11px]" />
          </div>
          <span className="text-[14px] font-semibold text-slate-700">Lecture Details</span>
        </div>

        <form onSubmit={handleSubmit} className="p-6 flex flex-col gap-5">
          {/* Title */}
          <div>
            <label className="block text-[12px] font-semibold text-slate-600 uppercase tracking-wide mb-2">
              Title <span className="text-red-500 normal-case">*</span>
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
            <label className="block text-[12px] font-semibold text-slate-600 uppercase tracking-wide mb-2">
              YouTube URL <span className="text-red-500 normal-case">*</span>
            </label>
            <div className="relative">
              <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
                <i className="fab fa-youtube text-red-500 text-[14px]" />
              </div>
              <input
                type="url"
                value={form.youtubeUrl}
                onChange={(e) => setForm((f) => ({ ...f, youtubeUrl: e.target.value }))}
                placeholder="https://www.youtube.com/watch?v=..."
                className={`${FIELD_CLASS} pl-10`}
              />
            </div>
            <p className="text-[11px] text-slate-400 mt-1.5">
              Accepts youtube.com/watch?v=... and youtu.be/... formats
            </p>
          </div>

          {/* Description */}
          <div>
            <label className="block text-[12px] font-semibold text-slate-600 uppercase tracking-wide mb-2">
              Description <span className="text-slate-400 normal-case font-normal">(optional)</span>
            </label>
            <textarea
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Brief description of lecture content for students…"
              rows={3}
              className={`${FIELD_CLASS} resize-none`}
            />
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2.5 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
              <i className="fas fa-circle-exclamation mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-2 border-t border-slate-100">
            <button
              type="submit"
              disabled={loading}
              className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 text-white rounded-xl text-[13px] font-semibold hover:bg-indigo-700 disabled:opacity-60 transition-colors shadow-sm"
            >
              {loading ? (
                <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Creating…</>
              ) : (
                <><i className="fas fa-plus text-[11px]" /> Create Lecture</>
              )}
            </button>
            <Link
              href="/admin/lectures"
              className="px-5 py-2.5 border border-slate-200 rounded-xl text-[13px] font-semibold text-slate-600 hover:bg-slate-50 transition-colors"
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>

      {/* Info note */}
      <div className="mt-4 flex items-start gap-2.5 px-4 py-3 bg-indigo-50 border border-indigo-100 rounded-xl">
        <i className="fas fa-circle-info text-indigo-500 mt-0.5 shrink-0" />
        <p className="text-[12px] text-indigo-700 leading-relaxed">
          After creating the lecture, you&apos;ll be taken to the detail page where you can upload an Excel dataset to activate the AI tutor.
        </p>
      </div>
    </div>
  );
}
