'use client';
import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { useQuery, useMutation } from '@apollo/client';
import { GET_LECTURE, UPDATE_LECTURE_MUTATION } from '@/graphql/lecture.queries';
import { datasetApi } from '@/lib/api';
import { DBLecture } from '@/types';

const POLLING_STATUSES = new Set(['DATASET_UPLOADED', 'PROCESSING', 'EMBEDDING']);

const STATUS_CONFIG: Record<string, { label: string; icon: string; dot: string; bg: string; border: string; text: string; desc: string }> = {
  NO_DATASET:       { label: 'No Dataset',    icon: 'fas fa-database',     dot: 'bg-slate-400',   bg: 'bg-slate-50',    border: 'border-slate-200',  text: 'text-slate-700',   desc: 'Upload an Excel dataset to activate the AI tutor for this lecture.' },
  DATASET_UPLOADED: { label: 'Dataset Ready', icon: 'fas fa-file-check',   dot: 'bg-amber-400',   bg: 'bg-amber-50',    border: 'border-amber-200',  text: 'text-amber-800',   desc: 'Dataset uploaded — processing will begin shortly.' },
  PROCESSING:       { label: 'Processing',    icon: 'fas fa-cog',          dot: 'bg-blue-400',    bg: 'bg-blue-50',     border: 'border-blue-200',   text: 'text-blue-800',    desc: 'Parsing dataset and preparing chunks — auto-refreshing every 3 s.' },
  EMBEDDING:        { label: 'Embedding',     icon: 'fas fa-brain',        dot: 'bg-violet-400',  bg: 'bg-violet-50',   border: 'border-violet-200', text: 'text-violet-800',  desc: 'Generating AI embeddings — this may take a few minutes.' },
  READY:            { label: 'AI Ready',      icon: 'fas fa-robot',        dot: 'bg-emerald-400', bg: 'bg-emerald-50',  border: 'border-emerald-200',text: 'text-emerald-800', desc: 'AI tutor is live and ready for students.' },
  FAILED:           { label: 'Failed',        icon: 'fas fa-circle-xmark', dot: 'bg-red-400',     bg: 'bg-red-50',      border: 'border-red-200',    text: 'text-red-800',     desc: 'Processing failed. Re-upload the dataset to try again.' },
};

const FIELD_CLASS = 'w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-800 outline-none focus:border-indigo-500 focus:bg-white focus:ring-2 focus:ring-indigo-100 transition-all placeholder:text-slate-400';

interface Props { params: { id: string } }

export default function LectureDetailPage({ params }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  const { data, loading, refetch } = useQuery(GET_LECTURE, {
    variables: { id: params.id },
    fetchPolicy: 'network-only',
  });
  const [updateLecture, { loading: updating }] = useMutation(UPDATE_LECTURE_MUTATION);

  const lecture: DBLecture | undefined = data?.lecture;

  const [editMode,    setEditMode]    = useState(false);
  const [editForm,    setEditForm]    = useState({ title: '', description: '', youtubeUrl: '' });
  const [editError,   setEditError]   = useState('');
  const [uploading,   setUploading]   = useState(false);
  const [uploadMsg,   setUploadMsg]   = useState('');
  const [uploadError, setUploadError] = useState('');

  useEffect(() => {
    if (!lecture || !POLLING_STATUSES.has(lecture.status)) return;
    const id = setInterval(() => {
      refetch().then(({ data: d }) => {
        const s = d?.lecture?.status;
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
    } catch (err: unknown) {
      setEditError((err as { graphQLErrors?: { message: string }[] })?.graphQLErrors?.[0]?.message ?? 'Update failed.');
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.xlsx')) { setUploadError('Only .xlsx files are accepted.'); return; }
    setUploading(true); setUploadMsg(''); setUploadError('');
    try {
      await datasetApi.upload(parseInt(params.id, 10), file);
      setUploadMsg('Dataset uploaded! Processing started — status updates automatically.');
      refetch();
    } catch (err: unknown) {
      setUploadError((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-7 h-7 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!lecture) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-slate-400">
        <i className="fas fa-file-circle-xmark text-4xl mb-3" />
        <p className="text-base font-semibold text-slate-600">Lecture not found</p>
        <Link href="/admin/lectures" className="mt-3 text-sm text-indigo-600 hover:underline">← Back to lectures</Link>
      </div>
    );
  }

  const s = STATUS_CONFIG[lecture.status] ?? STATUS_CONFIG.NO_DATASET;
  const isPolling = POLLING_STATUSES.has(lecture.status);
  const canUpload = ['NO_DATASET', 'DATASET_UPLOADED', 'FAILED', 'READY'].includes(lecture.status);

  return (
    <div className="max-w-3xl">
      {/* Back + title */}
      <div className="flex items-center gap-3 mb-7">
        <Link
          href="/admin/lectures"
          className="w-8 h-8 rounded-lg bg-white border border-slate-200 shadow-sm flex items-center justify-center text-slate-500 hover:text-slate-800 hover:border-slate-300 transition-colors"
        >
          <i className="fas fa-arrow-left text-[12px]" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-[22px] font-bold text-slate-900 line-clamp-1">{lecture.title}</h1>
          <p className="text-[12px] text-slate-400 font-mono mt-0.5">Lecture #{lecture.id}</p>
        </div>
      </div>

      {/* Status banner */}
      <div className={`flex items-center gap-4 rounded-2xl px-5 py-4 mb-5 border ${s.bg} ${s.border}`}>
        <div className={`w-10 h-10 rounded-xl bg-white/60 border ${s.border} flex items-center justify-center shrink-0`}>
          <i className={`${s.icon} ${s.text} ${lecture.status === 'PROCESSING' || lecture.status === 'EMBEDDING' ? 'fa-spin' : ''} text-[15px]`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={`text-[13px] font-bold ${s.text}`}>{s.label}</span>
            {isPolling && (
              <span className="flex items-center gap-1 text-[10px] font-medium text-slate-500 bg-white/70 px-2 py-0.5 rounded-full border border-slate-200">
                <span className={`w-1.5 h-1.5 rounded-full ${s.dot} animate-pulse`} />
                Auto-refreshing
              </span>
            )}
          </div>
          <p className={`text-[12px] ${s.text} opacity-75`}>{s.desc}</p>
        </div>
        {!isPolling && (
          <button
            onClick={() => refetch()}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/60 border border-current/20 text-[12px] font-semibold hover:bg-white/90 transition-colors"
          >
            <i className="fas fa-rotate-right text-[10px]" /> Refresh
          </button>
        )}
      </div>

      {/* Details card */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm mb-5 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/60">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center">
              <i className="fas fa-film text-white text-[11px]" />
            </div>
            <span className="text-[14px] font-semibold text-slate-700">Lecture Details</span>
          </div>
          {!editMode && (
            <button onClick={startEdit} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 text-[12px] font-semibold hover:bg-slate-100 transition-colors">
              <i className="fas fa-pen text-[10px]" /> Edit
            </button>
          )}
        </div>

        <div className="p-6">
          {editMode ? (
            <form onSubmit={handleUpdate} className="flex flex-col gap-4">
              <div>
                <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Title</label>
                <input value={editForm.title} onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))} className={FIELD_CLASS} />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">YouTube URL</label>
                <input value={editForm.youtubeUrl} onChange={(e) => setEditForm((f) => ({ ...f, youtubeUrl: e.target.value }))} className={FIELD_CLASS} />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Description</label>
                <textarea value={editForm.description} onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))} rows={2} className={`${FIELD_CLASS} resize-none`} />
              </div>
              {editError && (
                <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 text-sm text-red-700">
                  <i className="fas fa-circle-exclamation shrink-0" /> {editError}
                </div>
              )}
              <div className="flex gap-2.5 pt-1 border-t border-slate-100">
                <button type="submit" disabled={updating} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-[13px] font-semibold hover:bg-indigo-700 disabled:opacity-60 transition-colors">
                  {updating ? <><div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving…</> : <><i className="fas fa-check text-[11px]" /> Save Changes</>}
                </button>
                <button type="button" onClick={() => setEditMode(false)} className="px-4 py-2 border border-slate-200 rounded-xl text-[13px] font-semibold text-slate-600 hover:bg-slate-50 transition-colors">
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <dl className="grid grid-cols-2 gap-x-8 gap-y-5">
              <div>
                <dt className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Lecture ID</dt>
                <dd className="text-[13px] font-mono text-slate-700">#{lecture.id}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Created</dt>
                <dd className="text-[13px] text-slate-700">{new Date(lecture.createdAt).toLocaleString()}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1">YouTube URL</dt>
                <dd>
                  <a href={lecture.youtubeUrl} target="_blank" rel="noreferrer" className="text-[13px] text-indigo-600 hover:underline break-all">
                    {lecture.youtubeUrl}
                  </a>
                </dd>
              </div>
              {lecture.description && (
                <div className="col-span-2">
                  <dt className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Description</dt>
                  <dd className="text-[13px] text-slate-700 leading-relaxed">{lecture.description}</dd>
                </div>
              )}
            </dl>
          )}
        </div>
      </div>

      {/* Dataset upload card */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="flex items-center gap-2.5 px-6 py-4 border-b border-slate-100 bg-slate-50/60">
          <div className="w-7 h-7 rounded-lg bg-emerald-600 flex items-center justify-center">
            <i className="fas fa-table text-white text-[11px]" />
          </div>
          <span className="text-[14px] font-semibold text-slate-700">Dataset Upload</span>
        </div>

        <div className="p-6">
          <p className="text-[13px] text-slate-500 mb-4 leading-relaxed">
            Upload an <span className="font-semibold text-slate-700">.xlsx</span> file with columns:
            {' '}<code className="bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded text-[11px] font-mono">topic</code>,
            {' '}<code className="bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded text-[11px] font-mono">question</code>,
            {' '}<code className="bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded text-[11px] font-mono">answer</code>,
            {' '}<code className="bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded text-[11px] font-mono">keywords</code>,
            {' '}<code className="bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded text-[11px] font-mono">start_time</code>,
            {' '}<code className="bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded text-[11px] font-mono">end_time</code>.
          </p>

          {uploadMsg && (
            <div className="flex items-start gap-2.5 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 mb-4 text-sm text-emerald-800">
              <i className="fas fa-circle-check mt-0.5 shrink-0" /> {uploadMsg}
            </div>
          )}
          {uploadError && (
            <div className="flex items-start gap-2.5 bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-4 text-sm text-red-700">
              <i className="fas fa-circle-exclamation mt-0.5 shrink-0" /> {uploadError}
            </div>
          )}

          <input ref={fileRef} type="file" accept=".xlsx" className="hidden" onChange={handleFileUpload} />

          <div className="flex items-center gap-4">
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading || !canUpload}
              className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 text-white rounded-xl text-[13px] font-semibold hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              {uploading ? (
                <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Uploading…</>
              ) : (
                <><i className="fas fa-cloud-arrow-up" /> Upload Dataset (.xlsx)</>
              )}
            </button>
            {!canUpload && lecture.status !== 'READY' && (
              <p className="text-[12px] text-slate-400"><i className="fas fa-lock text-[10px] mr-1" /> Locked while processing</p>
            )}
            {lecture.status === 'READY' && (
              <p className="text-[12px] text-slate-400"><i className="fas fa-rotate-right text-[10px] mr-1" /> Re-upload to replace dataset</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
