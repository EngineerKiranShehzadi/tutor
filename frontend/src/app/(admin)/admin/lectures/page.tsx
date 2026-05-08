'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation } from '@apollo/client';
import { GET_LECTURES, DELETE_LECTURE_MUTATION } from '@/graphql/lecture.queries';
import { DBLecture } from '@/types';
import { cn } from '@/lib/cn';

const STATUS_CONFIG: Record<string, { label: string; dot: string; text: string; bg: string }> = {
  READY:            { label: 'AI Ready',      dot: 'bg-emerald-400', text: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200' },
  PROCESSING:       { label: 'Processing',    dot: 'bg-blue-400',    text: 'text-blue-700',    bg: 'bg-blue-50 border-blue-200'       },
  EMBEDDING:        { label: 'Embedding',     dot: 'bg-violet-400',  text: 'text-violet-700',  bg: 'bg-violet-50 border-violet-200'   },
  DATASET_UPLOADED: { label: 'Dataset Ready', dot: 'bg-amber-400',   text: 'text-amber-700',   bg: 'bg-amber-50 border-amber-200'     },
  NO_DATASET:       { label: 'No Dataset',    dot: 'bg-slate-400',   text: 'text-slate-600',   bg: 'bg-slate-100 border-slate-200'    },
  FAILED:           { label: 'Failed',        dot: 'bg-red-400',     text: 'text-red-700',     bg: 'bg-red-50 border-red-200'         },
};

export default function AdminLectures() {
  const router = useRouter();
  const { data, loading, refetch } = useQuery(GET_LECTURES, { fetchPolicy: 'network-only' });
  const [deleteLecture, { loading: deleting }] = useMutation(DELETE_LECTURE_MUTATION);

  const [search,      setSearch]      = useState('');
  const [deleteId,    setDeleteId]    = useState<string | null>(null); // inline confirm state
  const [deleteError, setDeleteError] = useState('');

  const allLectures: DBLecture[] = data?.lectures ?? [];
  const lectures = allLectures.filter(l => !search || l.title.toLowerCase().includes(search.toLowerCase()));
  const readyCount = allLectures.filter(l => l.status === 'READY').length;

  const handleDelete = async (id: string) => {
    if (deleteId !== id) {
      // First click: enter confirm state — Feedback principle
      setDeleteId(id);
      setDeleteError('');
      return;
    }
    // Second click: confirmed
    try {
      await deleteLecture({ variables: { id } });
      refetch();
      setDeleteId(null);
    } catch (err) {
      setDeleteError((err as { graphQLErrors?: { message: string }[] })?.graphQLErrors?.[0]?.message ?? 'Delete failed.');
    }
  };

  return (
    <div className="max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-7">
        <div>
          <h1 className="text-[22px] font-bold text-slate-900">Lectures</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {lectures.length} total &nbsp;·&nbsp;
            <span className="text-emerald-600 font-medium">{readyCount} AI-ready</span>
          </p>
        </div>
        <Link
          href="/admin/lectures/create"
          className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-[13px] font-semibold hover:bg-indigo-700 active:scale-95 transition-all shadow-sm"
        >
          <i className="fas fa-plus text-[11px]" /> New Lecture
        </Link>
      </div>

      {/* Search */}
      <div className="relative mb-5">
        <i className="fas fa-search absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-[12px]" />
        <input
          value={search}
          onChange={e => { setSearch(e.target.value); setDeleteId(null); }}
          placeholder="Search lectures by title…"
          className="w-full pl-9 pr-4 py-2.5 bg-white border border-slate-200 rounded-xl text-[13px] text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all"
        />
      </div>

      {/* Delete error banner — Feedback */}
      {deleteError && (
        <div className="mb-4 flex items-center gap-2.5 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-[13px] text-red-700">
          <i className="fas fa-circle-exclamation shrink-0" /> {deleteError}
          <button onClick={() => setDeleteError('')} className="ml-auto text-red-400 hover:text-red-600"><i className="fas fa-xmark" /></button>
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="flex items-center gap-4 px-6 py-4 border-b border-slate-100 last:border-0">
              <div className="w-8 h-5 bg-slate-100 rounded animate-pulse" />
              <div className="flex-1 h-4 bg-slate-100 rounded animate-pulse" />
              <div className="w-20 h-5 bg-slate-100 rounded-full animate-pulse" />
              <div className="w-24 h-4 bg-slate-100 rounded animate-pulse" />
              <div className="w-20 h-8 bg-slate-100 rounded-lg animate-pulse" />
            </div>
          ))}
        </div>
      ) : lectures.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col items-center justify-center py-20 text-slate-400">
          <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center mb-4">
            <i className="fas fa-film text-2xl text-slate-400" />
          </div>
          <p className="text-base font-semibold text-slate-600">No lectures yet</p>
          <p className="text-sm mt-1">Create your first lecture and upload a dataset to activate AI.</p>
          <Link
            href="/admin/lectures/create"
            className="mt-5 flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 transition-colors"
          >
            <i className="fas fa-plus text-[10px]" /> Create Lecture
          </Link>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80">
                <th className="text-left px-6 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest w-12">ID</th>
                <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest">Lecture</th>
                <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest w-36">Status</th>
                <th className="text-left px-4 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest w-28">Created</th>
                {/* Visibility: "Actions" column always present and labelled */}
                <th className="text-right px-6 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-widest w-36">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lectures.map(lec => {
                const s           = STATUS_CONFIG[lec.status] ?? STATUS_CONFIG.NO_DATASET;
                const confirming  = deleteId === lec.id;
                return (
                  <tr
                    key={lec.id}
                    className={cn('transition-colors', confirming ? 'bg-red-50' : 'hover:bg-slate-50/60')}
                  >
                    <td className="px-6 py-4 text-[12px] text-slate-400 font-mono">#{lec.id}</td>
                    <td className="px-4 py-4">
                      <p className="text-[14px] font-semibold text-slate-800 line-clamp-1">{lec.title}</p>
                      {lec.youtubeVideoId && (
                        <p className="text-[11px] text-slate-400 font-mono mt-0.5">{lec.youtubeVideoId}</p>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-semibold border ${s.bg} ${s.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${s.dot} ${lec.status === 'PROCESSING' || lec.status === 'EMBEDDING' ? 'animate-pulse' : ''}`} />
                        {s.label}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-[12px] text-slate-500">
                      {new Date(lec.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                    <td className="px-6 py-4">
                      {/* Visibility: actions always visible — no opacity-0 hidden-on-hover */}
                      <div className="flex items-center justify-end gap-1.5">
                        {confirming ? (
                          <>
                            {/* Feedback: inline confirm replaces native browser confirm() */}
                            <span className="text-[12px] text-red-600 font-medium mr-1">Delete?</span>
                            <button
                              onClick={() => handleDelete(lec.id)}
                              disabled={deleting}
                              className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-[12px] font-semibold hover:bg-red-700 transition-colors disabled:opacity-60"
                            >
                              {deleting ? <i className="fas fa-spinner animate-spin text-[10px]" /> : 'Yes, delete'}
                            </button>
                            <button
                              onClick={() => setDeleteId(null)}
                              className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600 text-[12px] font-semibold hover:bg-slate-200 transition-colors border border-slate-200"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => router.push(`/admin/lectures/${lec.id}`)}
                              className="px-3 py-1.5 rounded-lg bg-indigo-50 text-indigo-700 text-[12px] font-semibold hover:bg-indigo-100 active:scale-95 transition-all border border-indigo-100"
                            >
                              <i className="fas fa-arrow-up-right-from-square text-[10px] mr-1" /> Open
                            </button>
                            <button
                              onClick={() => handleDelete(lec.id)}
                              className="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-[12px] font-semibold hover:bg-red-100 active:scale-95 transition-all border border-red-100 flex items-center gap-1"
                            >
                              <i className="fas fa-trash text-[10px]" /> Delete
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="px-6 py-3 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between">
            <span className="text-[12px] text-slate-400">{lectures.length} lecture{lectures.length !== 1 ? 's' : ''}</span>
            <button onClick={() => refetch()} className="text-[12px] text-slate-500 hover:text-indigo-600 font-medium transition-colors">
              <i className="fas fa-rotate-right mr-1 text-[10px]" /> Refresh
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
