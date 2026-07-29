'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation } from '@apollo/client';
import { GET_LECTURES, DELETE_LECTURE_MUTATION } from '@/graphql/lecture.queries';
import { DBLecture } from '@/types';
import { AdminPageHero } from '@/components/admin/AdminPageHero';

const STATUS_CONFIG: Record<string, { label: string; dot: string; text: string; bg: string; accent: string }> = {
  READY:            { label: 'AI Ready',      dot: 'bg-emerald-400', text: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200', accent: 'bg-emerald-500' },
  PROCESSING:       { label: 'Processing',    dot: 'bg-blue-400',    text: 'text-blue-700',    bg: 'bg-blue-50 border-blue-200',       accent: 'bg-blue-500'    },
  EMBEDDING:        { label: 'Embedding',     dot: 'bg-violet-400',  text: 'text-violet-700',  bg: 'bg-violet-50 border-violet-200',   accent: 'bg-violet-500'  },
  DATASET_UPLOADED: { label: 'Dataset Ready', dot: 'bg-amber-400',   text: 'text-amber-700',   bg: 'bg-amber-50 border-amber-200',     accent: 'bg-amber-500'   },
  NO_DATASET:       { label: 'No Dataset',    dot: 'bg-slate-400',   text: 'text-slate-500',   bg: 'bg-slate-100 border-slate-200',    accent: 'bg-slate-300'   },
  FAILED:           { label: 'Failed',        dot: 'bg-red-400',     text: 'text-red-700',     bg: 'bg-red-50 border-red-200',         accent: 'bg-red-500'     },
};

const STAT_ICONS: Record<string, { icon: string; color: string; bg: string }> = {
  total:      { icon: 'fas fa-layer-group',  color: 'text-indigo-600',  bg: 'bg-indigo-50'  },
  ready:      { icon: 'fas fa-robot',        color: 'text-emerald-600', bg: 'bg-emerald-50' },
  processing: { icon: 'fas fa-cog',          color: 'text-blue-600',    bg: 'bg-blue-50'    },
  noDataset:  { icon: 'fas fa-database',     color: 'text-slate-500',   bg: 'bg-slate-100'  },
};

export default function AdminLectures() {
  const router = useRouter();
  const { data, loading, refetch } = useQuery(GET_LECTURES, { fetchPolicy: 'network-only' });
  const [deleteLecture, { loading: deleting }] = useMutation(DELETE_LECTURE_MUTATION);

  const [search,      setSearch]      = useState('');
  const [deleteId,    setDeleteId]    = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');

  const allLectures: DBLecture[] = data?.lectures ?? [];
  const lectures    = allLectures.filter(l => !search || l.title.toLowerCase().includes(search.toLowerCase()));
  const readyCount  = allLectures.filter(l => l.status === 'READY').length;
  const activeCount = allLectures.filter(l => l.status === 'PROCESSING' || l.status === 'EMBEDDING').length;
  const noDataCount = allLectures.filter(l => l.status === 'NO_DATASET').length;

  const handleDelete = async (id: string) => {
    if (deleteId !== id) { setDeleteId(id); setDeleteError(''); return; }
    try {
      await deleteLecture({ variables: { id } });
      refetch();
      setDeleteId(null);
    } catch (err) {
      setDeleteError((err as { graphQLErrors?: { message: string }[] })?.graphQLErrors?.[0]?.message ?? 'Delete failed.');
    }
  };

  return (
    <div className="max-w-[1500px]">
      <AdminPageHero
        icon="fas fa-play-circle"
        iconGradient="from-violet-500 to-indigo-600"
        title="Lectures"
        subtitle={`${allLectures.length} total · ${readyCount} AI-ready`}
        action={
          <Link
            href="/admin/lectures/create"
            className="flex items-center gap-2 px-5 py-2.5 bg-white/15 text-white border border-white/25 backdrop-blur-sm rounded-xl text-[14px] font-semibold hover:bg-white/25 active:scale-95 transition-all"
          >
            <i className="fas fa-plus text-[11px]" /> New Lecture
          </Link>
        }
      />

      {/* Stats summary */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { key: 'total',      label: 'Total Lectures',  value: loading ? '—' : allLectures.length },
          { key: 'ready',      label: 'AI Ready',        value: loading ? '—' : readyCount          },
          { key: 'processing', label: 'Processing',      value: loading ? '—' : activeCount         },
          { key: 'noDataset',  label: 'No Dataset',      value: loading ? '—' : noDataCount         },
        ].map(stat => {
          const cfg = STAT_ICONS[stat.key];
          return (
            <div key={stat.key} className="bg-white rounded-2xl border border-slate-200 shadow-sm px-5 py-4 flex items-center gap-4">
              <div className={`w-10 h-10 rounded-xl ${cfg.bg} flex items-center justify-center shrink-0`}>
                <i className={`${cfg.icon} ${cfg.color} text-[16px]`} />
              </div>
              <div>
                <p className="text-[24px] font-extrabold text-slate-900 leading-none">{stat.value}</p>
                <p className="text-[12px] text-slate-400 font-medium mt-0.5">{stat.label}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Search */}
      <div className="relative mb-5">
        <i className="fas fa-search absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-[13px]" />
        <input
          value={search}
          onChange={e => { setSearch(e.target.value); setDeleteId(null); }}
          placeholder="Search lectures by title…"
          className="w-full pl-11 pr-4 py-3 bg-white border border-slate-200 rounded-xl text-[14px] text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all shadow-sm placeholder:text-slate-400"
        />
      </div>

      {/* Delete error */}
      {deleteError && (
        <div className="mb-4 flex items-center gap-2.5 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-[13px] text-red-700">
          <i className="fas fa-circle-exclamation shrink-0" /> {deleteError}
          <button onClick={() => setDeleteError('')} className="ml-auto text-red-400 hover:text-red-600"><i className="fas fa-xmark" /></button>
        </div>
      )}

      {/* Loading skeletons */}
      {loading ? (
        <div className="flex flex-col gap-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex animate-pulse">
              <div className="w-1.5 bg-slate-200 shrink-0" />
              <div className="flex-1 px-6 py-5 flex items-center gap-5">
                <div className="w-10 h-10 rounded-xl bg-slate-100 shrink-0" />
                <div className="flex-1 space-y-2.5">
                  <div className="h-4 bg-slate-100 rounded w-3/4" />
                  <div className="h-3 bg-slate-100 rounded w-1/4" />
                </div>
                <div className="w-24 h-7 bg-slate-100 rounded-full" />
                <div className="w-24 h-4 bg-slate-100 rounded" />
                <div className="flex gap-2">
                  <div className="w-16 h-8 bg-slate-100 rounded-xl" />
                  <div className="w-16 h-8 bg-slate-100 rounded-xl" />
                </div>
              </div>
            </div>
          ))}
        </div>

      /* Empty state */
      ) : lectures.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col items-center justify-center py-28">
          <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-indigo-50 to-violet-100 flex items-center justify-center mb-5 shadow-inner">
            <i className="fas fa-film text-3xl text-indigo-400" />
          </div>
          <p className="text-[17px] font-bold text-slate-700 mb-1">No lectures yet</p>
          <p className="text-[13px] text-slate-400 mb-6 text-center max-w-xs">
            Create your first lecture and upload a Q&amp;A dataset to activate the AI tutor.
          </p>
          <Link
            href="/admin/lectures/create"
            className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 text-white rounded-xl text-[13px] font-semibold hover:bg-indigo-700 transition-colors shadow-sm"
          >
            <i className="fas fa-plus text-[10px]" /> Create First Lecture
          </Link>
        </div>

      /* Lecture cards */
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {lectures.map((lec, idx) => {
              const s          = STATUS_CONFIG[lec.status] ?? STATUS_CONFIG.NO_DATASET;
              const confirming = deleteId === lec.id;
              return (
                <div
                  key={lec.id}
                  className={`group bg-white rounded-2xl border shadow-sm overflow-hidden flex transition-all duration-150 ${
                    confirming ? 'border-red-200' : 'border-slate-200 hover:border-indigo-200 hover:shadow-md'
                  }`}
                >
                  {/* Left accent bar */}
                  <div className={`w-1.5 shrink-0 ${confirming ? 'bg-red-400' : s.accent} transition-colors`} />

                  <div className={`flex-1 px-6 py-5 flex items-center gap-5 ${confirming ? 'bg-red-50' : ''}`}>
                    {/* Icon */}
                    <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center shrink-0">
                      <span className="text-[13px] font-bold text-slate-400">#{idx + 1}</span>
                    </div>

                    {/* Title + video id */}
                    <div className="flex-1 min-w-0">
                      <p className="text-[15px] font-semibold text-slate-800 truncate leading-snug">{lec.title}</p>
                      {lec.youtubeVideoId && (
                        <p className="text-[11px] text-slate-400 font-mono mt-0.5 truncate">{lec.youtubeVideoId}</p>
                      )}
                    </div>

                    {/* Status */}
                    <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold border shrink-0 ${s.bg} ${s.text}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${s.dot} ${lec.status === 'PROCESSING' || lec.status === 'EMBEDDING' ? 'animate-pulse' : ''}`} />
                      {s.label}
                    </span>

                    {/* Date */}
                    <div className="shrink-0 text-right w-28">
                      <p className="text-[11px] text-slate-400 font-medium uppercase tracking-wide">Created</p>
                      <p className="text-[13px] text-slate-600 font-semibold mt-0.5">
                        {new Date(lec.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                      </p>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 shrink-0">
                      {confirming ? (
                        <>
                          <span className="text-[12px] text-red-600 font-semibold">Delete?</span>
                          <button
                            onClick={() => handleDelete(lec.id)}
                            disabled={deleting}
                            className="px-3 py-1.5 rounded-xl bg-red-600 text-white text-[12px] font-semibold hover:bg-red-700 transition-colors disabled:opacity-60"
                          >
                            {deleting ? <i className="fas fa-spinner animate-spin text-[10px]" /> : 'Yes, delete'}
                          </button>
                          <button
                            onClick={() => setDeleteId(null)}
                            className="px-3 py-1.5 rounded-xl bg-white text-slate-600 text-[12px] font-semibold hover:bg-slate-100 transition-colors border border-slate-200"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => router.push(`/admin/lectures/${lec.id}`)}
                            className="px-4 py-1.5 rounded-xl bg-indigo-50 text-indigo-700 text-[12px] font-semibold hover:bg-indigo-100 active:scale-95 transition-all border border-indigo-100"
                          >
                            <i className="fas fa-arrow-up-right-from-square text-[10px] mr-1.5" /> Open
                          </button>
                          <button
                            onClick={() => handleDelete(lec.id)}
                            className="px-4 py-1.5 rounded-xl bg-red-50 text-red-600 text-[12px] font-semibold hover:bg-red-100 active:scale-95 transition-all border border-red-100"
                          >
                            <i className="fas fa-trash text-[10px] mr-1.5" /> Delete
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-1 pt-4">
            <span className="text-[12px] text-slate-400">{lectures.length} lecture{lectures.length !== 1 ? 's' : ''}</span>
            <button onClick={() => refetch()} className="text-[12px] text-slate-400 hover:text-indigo-600 font-medium transition-colors">
              <i className="fas fa-rotate-right mr-1 text-[10px]" /> Refresh
            </button>
          </div>
        </>
      )}
    </div>
  );
}
