'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery } from '@apollo/client';
import { CREATE_COURSE, GET_COURSES, UPDATE_COURSE } from '@/graphql/course.queries';
import { DBCourse } from '@/types/course';
import { AdminPageHero } from '@/components/admin/AdminPageHero';

const inputStyle = 'w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-800 outline-none focus:border-indigo-500';
const initial = { title: '', subtitle: '', description: '' };

export default function AdminCoursesPage() {
  const { data, loading, error, refetch } = useQuery(GET_COURSES, { fetchPolicy: 'network-only' });
  const [createCourse, { loading: creating }] = useMutation(CREATE_COURSE);
  const [updateCourse, { loading: updating }] = useMutation(UPDATE_COURSE);
  const [form, setForm] = useState(initial);
  const [editId, setEditId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [formError, setFormError] = useState('');
  const courses: DBCourse[] = data?.courses ?? [];

  const startEdit = (course: DBCourse) => {
    setEditId(course.id);
    setForm({ title: course.title, subtitle: course.subtitle, description: course.description });
    setFormError(''); setNotice('');
  };
  const reset = () => {
    setEditId(null);
    setForm(initial);
    setFormError('');
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(''); setNotice('');
    if (!form.title.trim()) { setFormError('Course title is required.'); return; }
    try {
      const input = { title: form.title.trim(), subtitle: form.subtitle.trim(), description: form.description.trim() };
      if (editId) {
        await updateCourse({ variables: { id: editId, input } });
        setNotice('Course updated successfully.');
      } else {
        await createCourse({ variables: { input } });
        setNotice('Course created. You can now add its lectures.');
      }
      reset();
      await refetch();
    } catch (err) {
      setFormError((err as {graphQLErrors?: {message:string}[]})?.graphQLErrors?.[0]?.message ?? 'Could not save course.');
    }
  };
  return (
    <div className="max-w-[1500px]">
      <AdminPageHero
        icon="fas fa-layer-group"
        iconGradient="from-violet-500 to-indigo-600"
        title="Courses"
        subtitle="Create courses, then add lectures and learning material to each course."
      />
      {notice && <div role="status" className="mb-5 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-800">{notice}</div>}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-6 items-start">
        <section className="space-y-3">
          <h2 className="text-lg font-bold text-slate-800 mb-4">Available Courses</h2>
          {loading ? <div className="text-sm text-slate-500">Loading courses…</div>
          : error ? <div className="text-sm text-red-600">Unable to load courses. <button onClick={() => void refetch()} className="underline">Retry</button></div>
          : courses.length === 0 ? <div className="border border-slate-200 bg-white rounded-xl p-8 text-sm text-slate-500">No courses yet.</div>
          : courses.map(course => (
            <div key={course.id} className="rounded-2xl border border-slate-200 bg-white px-5 py-5 shadow-sm">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
                  <i className="fas fa-book-open" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-slate-800">{course.title}</h3>
                  {course.subtitle && <p className="text-sm text-slate-500 mt-1">{course.subtitle}</p>}
                  {course.description && <p className="text-xs text-slate-400 mt-2">{course.description}</p>}
                  <p className="text-xs text-slate-500 mt-3">{course.lectureCount} lectures · {course.readyCount} AI-ready</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 mt-4 pt-3 border-t border-slate-100">
                <Link href={`/admin/lectures?courseId=${encodeURIComponent(course.id)}`} className="rounded-lg border border-indigo-100 bg-indigo-50 text-indigo-700 px-3 py-2 text-xs font-semibold hover:bg-indigo-100">View Lectures</Link>
                <Link href={`/admin/lectures/create?courseId=${encodeURIComponent(course.id)}`} className="rounded-lg bg-indigo-600 text-white px-3 py-2 text-xs font-semibold hover:bg-indigo-700">+ Add Lecture</Link>
                <button type="button" onClick={() => startEdit(course)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50">Edit Details</button>
              </div>
            </div>
          ))}
        </section>
        <section className="rounded-2xl bg-white border border-slate-200 shadow-sm p-6">
          <h2 className="text-lg font-bold text-slate-800 mb-1">{editId ? 'Edit Course' : 'Create Course'}</h2>
          <p className="text-xs text-slate-500 mb-5">Lectures and their uploaded datasets stay separate within each course.</p>
          <form onSubmit={save} className="space-y-4">
            <label className="block text-xs font-semibold text-slate-600">
              Course Title *
              <input value={form.title} onChange={e => setForm({...form,title:e.target.value})} maxLength={160} required className={inputStyle + ' mt-2'} placeholder="e.g. Python Programming" />
            </label>
            <label className="block text-xs font-semibold text-slate-600">
              Subtitle
              <input value={form.subtitle} onChange={e => setForm({...form,subtitle:e.target.value})} maxLength={240} className={inputStyle + ' mt-2'} placeholder="A short learning promise" />
            </label>
            <label className="block text-xs font-semibold text-slate-600">
              Description
              <textarea value={form.description} onChange={e => setForm({...form,description:e.target.value})} maxLength={2000} rows={4} className={inputStyle + ' mt-2 resize-none'} placeholder="What will students learn?" />
            </label>
            {formError && <p role="alert" className="text-sm text-red-600">{formError}</p>}
            <div className="flex gap-2">
              <button type="submit" disabled={creating || updating} className="bg-indigo-600 text-white rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-50 hover:bg-indigo-700">
                {creating || updating ? 'Saving…' : editId ? 'Save Changes' : 'Create Course'}
              </button>
              {editId && <button type="button" onClick={reset} className="border border-slate-200 px-4 py-2.5 rounded-xl text-sm text-slate-600">Cancel</button>}
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
