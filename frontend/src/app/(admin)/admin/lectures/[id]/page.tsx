'use client';
import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { useQuery, useMutation } from '@apollo/client';
import { GET_LECTURE, UPDATE_LECTURE_MUTATION } from '@/graphql/lecture.queries';
import { GET_LECTURE_CHUNKS } from '@/graphql/admin.queries';
import { datasetApi } from '@/lib/api';
import { DBLecture } from '@/types';
import { AdminPageHero } from '@/components/admin/AdminPageHero';

interface QnaChunk { id: number; topic: string | null; question: string; answer: string; startTime: string | null; endTime: string | null; keywords: string | null }

const POLLING_STATUSES = new Set(['DATASET_UPLOADED', 'PROCESSING', 'EMBEDDING']);

const STATUS_CONFIG: Record<string, { label: string; icon: string; dot: string; bg: string; border: string; text: string; desc: string }> = {
  NO_DATASET:       { label: 'No Dataset',    icon: 'fas fa-database',     dot: 'bg-slate-400',   bg: 'bg-slate-50',    border: 'border-slate-200',  text: 'text-slate-700',   desc: 'Upload an Excel dataset to activate the AI tutor for this lecture.' },
  DATASET_UPLOADED: { label: 'Dataset Ready', icon: 'fas fa-file-check',   dot: 'bg-amber-400',   bg: 'bg-amber-50',    border: 'border-amber-200',  text: 'text-amber-800',   desc: 'Dataset uploaded — processing will begin shortly.' },
  PROCESSING:       { label: 'Processing',    icon: 'fas fa-cog',          dot: 'bg-blue-400',    bg: 'bg-blue-50',     border: 'border-blue-200',   text: 'text-blue-800',    desc: 'Parsing dataset and preparing chunks — auto-refreshing every 3 s.' },
  EMBEDDING:        { label: 'Embedding',     icon: 'fas fa-brain',        dot: 'bg-violet-400',  bg: 'bg-violet-50',   border: 'border-violet-200', text: 'text-violet-800',  desc: 'Generating AI embeddings — this may take a few minutes.' },
  READY:            { label: 'AI Ready',      icon: 'fas fa-robot',        dot: 'bg-emerald-400', bg: 'bg-emerald-50',  border: 'border-emerald-200',text: 'text-emerald-800', desc: 'AI tutor is live and ready for students.' },
  FAILED:           { label: 'Failed',        icon: 'fas fa-circle-xmark', dot: 'bg-red-400',     bg: 'bg-red-50',      border: 'border-red-200',    text: 'text-red-800',     desc: 'Processing failed. Re-upload the dataset to try again.' },
};

const FIELD_CLASS = 'w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-base text-slate-800 outline-none focus:border-indigo-500 focus:bg-white focus:ring-2 focus:ring-indigo-100 transition-all placeholder:text-slate-400';

const STATUS_GRADIENT: Record<string, string> = {
  READY:            'from-emerald-500 to-teal-600',
  FAILED:           'from-red-500 to-rose-600',
  EMBEDDING:        'from-violet-500 to-purple-600',
  PROCESSING:       'from-blue-500 to-indigo-600',
  DATASET_UPLOADED: 'from-amber-500 to-orange-600',
  NO_DATASET:       'from-slate-500 to-slate-600',
};

interface Props { params: { id: string } }

export default function LectureDetailPage({ params }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  const { data, loading, refetch } = useQuery(GET_LECTURE, {
    variables: { id: params.id },
    fetchPolicy: 'network-only',
  });
  const [updateLecture, { loading: updating }] = useMutation(UPDATE_LECTURE_MUTATION);

  const lecture: DBLecture | undefined = data?.lecture;

  const [chunkSearch, setChunkSearch] = useState('');
  const [chunkPage,   setChunkPage]   = useState(1);
  const CHUNK_PAGE_SIZE = 10;

  const { data: chunksData, loading: chunksLoading } = useQuery(GET_LECTURE_CHUNKS, {
    variables: { lectureId: parseInt(params.id, 10) },
    fetchPolicy: 'network-only',
    skip: !data?.lecture || data.lecture.status !== 'READY',
  });
  const allChunks: QnaChunk[] = chunksData?.lectureChunks ?? [];
  const filteredChunks = allChunks.filter(c =>
    !chunkSearch ||
    c.question.toLowerCase().includes(chunkSearch.toLowerCase()) ||
    (c.topic ?? '').toLowerCase().includes(chunkSearch.toLowerCase())
  );
  const chunkPages = Math.max(1, Math.ceil(filteredChunks.length / CHUNK_PAGE_SIZE));
  const pagedChunks = filteredChunks.slice((chunkPage - 1) * CHUNK_PAGE_SIZE, chunkPage * CHUNK_PAGE_SIZE);

  const [editMode,    setEditMode]    = useState(false);
  const [editForm,    setEditForm]    = useState({ title: '', description: '', youtubeUrl: '' });
  const [editError,   setEditError]   = useState('');
  const [savedNotif,  setSavedNotif]  = useState(false);
  const [uploading,   setUploading]   = useState(false);
  const [uploadMsg,   setUploadMsg]   = useState('');
  const [uploadError, setUploadError] = useState('');

  // Track actual embedding rate across polls: { count, timestamp }
  const prevProgressRef = useRef<{ count: number; ts: number } | null>(null);
  const [chunksPerSec, setChunksPerSec] = useState<number | null>(null);

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
      setSavedNotif(true);
      setTimeout(() => setSavedNotif(false), 3000);
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
    <div>

      {/* Hero — outside max-w so it spans the full content area */}
      <AdminPageHero
        icon={s.icon}
        iconGradient={STATUS_GRADIENT[lecture.status] ?? 'from-slate-500 to-slate-600'}
        title={lecture.title}
        subtitle={`Lecture #${lecture.id} · ${s.desc}`}
        badge={s.label}
        action={
          <Link
            href="/admin/lectures"
            className="flex items-center gap-2 px-4 py-2 bg-white/15 text-white border border-white/25 backdrop-blur-sm rounded-xl text-[17px] font-semibold hover:bg-white/25 transition-all"
          >
            <i className="fas fa-arrow-left text-[17px]" /> Back to Lectures
          </Link>
        }
      />

      {/* Centered content */}
      <div className="max-w-[1100px] mx-auto">

      {/* Status banner */}
      <div className={`flex items-center gap-4 rounded-2xl px-5 py-4 mb-6 border ${s.bg} ${s.border}`}>
        <div className={`w-10 h-10 rounded-xl bg-white/60 border ${s.border} flex items-center justify-center shrink-0`}>
          <i className={`${s.icon} ${s.text} ${lecture.status === 'PROCESSING' || lecture.status === 'EMBEDDING' ? 'fa-spin' : ''} text-[17px]`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={`text-[17px] font-bold ${s.text}`}>{s.label}</span>
            {isPolling && (
              <span className="flex items-center gap-1 text-[17px] font-medium text-slate-500 bg-white/70 px-2 py-0.5 rounded-full border border-slate-200">
                <span className={`w-1.5 h-1.5 rounded-full ${s.dot} animate-pulse`} />
                Auto-refreshing
              </span>
            )}
          </div>
          <p className={`text-[17px] ${s.text} opacity-75`}>{s.desc}</p>
        </div>
        {!isPolling && (
          <button
            onClick={() => refetch()}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/60 border border-current/20 text-[17px] font-semibold hover:bg-white/90 transition-colors"
          >
            <i className="fas fa-rotate-right text-[17px]" /> Refresh
          </button>
        )}
      </div>

      {/* Layout: during active processing show left cards + right progress card; otherwise normal 2-col */}
      {(() => {
        const showProgress = (lecture.status === 'PROCESSING' || lecture.status === 'EMBEDDING') && lecture.progressTotal > 0;
        const pct       = showProgress ? Math.round((lecture.progressCurrent / lecture.progressTotal) * 100) : 0;
        const remaining = showProgress ? lecture.progressTotal - lecture.progressCurrent : 0;
        // Use measured rate if available, else no estimate
        const estSecs   = (lecture.status === 'EMBEDDING' && chunksPerSec && chunksPerSec > 0)
          ? Math.ceil(remaining / chunksPerSec)
          : null;
        const estLabel  = estSecs === null ? null
          : estSecs < 60  ? `~${estSecs}s`
          : `~${Math.ceil(estSecs / 60)} min`;

        const STEPS = [
          { key: 'parse',   label: 'Parse & Validate',      icon: 'fas fa-file-check',  done: true },
          { key: 'insert',  label: 'Insert Chunks',         icon: 'fas fa-database',    done: lecture.status !== 'PROCESSING', active: lecture.status === 'PROCESSING' },
          { key: 'embed',   label: 'Generate Embeddings',   icon: 'fas fa-brain',       done: false, active: lecture.status === 'EMBEDDING' },
          { key: 'ready',   label: 'AI Tutor Ready',        icon: 'fas fa-robot',       done: false },
        ];

        const detailsCard = (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/60">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center">
                  <i className="fas fa-film text-white text-[17px]" />
                </div>
                <span className="text-[16px] font-semibold text-slate-700">Lecture Details</span>
              </div>
              {!editMode && (
                <button onClick={startEdit} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 text-[17px] font-semibold hover:bg-slate-100 transition-colors">
                  <i className="fas fa-pen text-[17px]" /> Edit
                </button>
              )}
            </div>
            <div className="p-6">
              {editMode ? (
                <form onSubmit={handleUpdate} className="flex flex-col gap-4">
                  <div>
                    <label className="block text-[17px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Title</label>
                    <input value={editForm.title} onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))} className={FIELD_CLASS} />
                  </div>
                  <div>
                    <label className="block text-[17px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">YouTube URL</label>
                    <input value={editForm.youtubeUrl} onChange={(e) => setEditForm((f) => ({ ...f, youtubeUrl: e.target.value }))} className={FIELD_CLASS} />
                  </div>
                  <div>
                    <label className="block text-[17px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Description</label>
                    <textarea value={editForm.description} onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))} rows={2} className={`${FIELD_CLASS} resize-none`} />
                  </div>
                  {editError && (
                    <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 text-base text-red-700">
                      <i className="fas fa-circle-exclamation shrink-0" /> {editError}
                    </div>
                  )}
                  <div className="flex gap-2.5 pt-1 border-t border-slate-100">
                    <button type="submit" disabled={updating} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-[17px] font-semibold hover:bg-indigo-700 disabled:opacity-60 transition-colors">
                      {updating ? <><div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving…</> : <><i className="fas fa-check text-[17px]" /> Save Changes</>}
                    </button>
                    <button type="button" onClick={() => setEditMode(false)} className="px-4 py-2 border border-slate-200 rounded-xl text-[17px] font-semibold text-slate-600 hover:bg-slate-50 transition-colors">
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <dl className="grid grid-cols-2 gap-x-8 gap-y-5">
                  <div>
                    <dt className="text-[17px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Lecture ID</dt>
                    <dd className="text-[17px] font-mono text-slate-700">#{lecture.id}</dd>
                  </div>
                  <div>
                    <dt className="text-[17px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Created</dt>
                    <dd className="text-[17px] text-slate-700">{new Date(lecture.createdAt).toLocaleString()}</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-[17px] font-semibold text-slate-400 uppercase tracking-wide mb-1">YouTube URL</dt>
                    <dd>
                      <a href={lecture.youtubeUrl} target="_blank" rel="noreferrer" className="text-[17px] text-indigo-600 hover:underline break-all">
                        {lecture.youtubeUrl}
                      </a>
                    </dd>
                  </div>
                  {lecture.description && (
                    <div className="col-span-2">
                      <dt className="text-[17px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Description</dt>
                      <dd className="text-[17px] text-slate-700 leading-relaxed">{lecture.description}</dd>
                    </div>
                  )}
                </dl>
              )}
            </div>
          </div>
        );

        const uploadCard = (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="flex items-center gap-2.5 px-6 py-4 border-b border-slate-100 bg-slate-50/60">
              <div className="w-7 h-7 rounded-lg bg-emerald-600 flex items-center justify-center">
                <i className="fas fa-table text-white text-[17px]" />
              </div>
              <span className="text-[16px] font-semibold text-slate-700">Dataset Upload</span>
            </div>
            <div className="p-6">
              <p className="text-[17px] text-slate-500 mb-4 leading-relaxed">
                Upload the lecture Q&amp;A dataset to power the AI tutor.
              </p>
              {uploadMsg && (
                <div className="flex items-start gap-2.5 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 mb-4 text-base text-emerald-800">
                  <i className="fas fa-circle-check mt-0.5 shrink-0" /> {uploadMsg}
                </div>
              )}
              {uploadError && (
                <div className="flex items-start gap-2.5 bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-4 text-base text-red-700">
                  <i className="fas fa-circle-exclamation mt-0.5 shrink-0" /> {uploadError}
                </div>
              )}
              <input ref={fileRef} type="file" accept=".xlsx" className="hidden" onChange={handleFileUpload} />
              <div className="flex items-center gap-4">
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading || !canUpload}
                  className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 text-white rounded-xl text-[17px] font-semibold hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                >
                  {uploading ? (
                    <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Uploading…</>
                  ) : (
                    <><i className="fas fa-cloud-arrow-up" /> Upload Dataset (.xlsx)</>
                  )}
                </button>
                {!canUpload && lecture.status !== 'READY' && (
                  <p className="text-[17px] text-slate-400"><i className="fas fa-lock text-[17px] mr-1" /> Locked while processing</p>
                )}
                {lecture.status === 'READY' && (
                  <p className="text-[17px] text-slate-400"><i className="fas fa-rotate-right text-[17px] mr-1" /> Re-upload to replace dataset</p>
                )}
              </div>
            </div>
          </div>
        );

        if (showProgress) {
          const activeStep = lecture.status === 'PROCESSING' ? 1 : 2;
          return (
            <div className="grid grid-cols-[1fr_1.1fr] gap-5 mb-5">
              {/* Left: stacked cards */}
              <div className="flex flex-col gap-5">
                {detailsCard}
                {uploadCard}
              </div>

              {/* Right: professional progress card */}
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
                {/* Card header */}
                <div className="flex items-center gap-2.5 px-6 py-4 border-b border-slate-100 bg-slate-50/60">
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${lecture.status === 'PROCESSING' ? 'bg-blue-600' : 'bg-violet-600'}`}>
                    <i className={`${lecture.status === 'PROCESSING' ? 'fas fa-cog fa-spin' : 'fas fa-brain fa-spin'} text-white text-[14px]`} />
                  </div>
                  <span className="text-[16px] font-semibold text-slate-700">Processing Progress</span>
                  <span className={`ml-auto text-[13px] font-bold px-2.5 py-1 rounded-full ${lecture.status === 'PROCESSING' ? 'bg-blue-50 text-blue-700 border border-blue-200' : 'bg-violet-50 text-violet-700 border border-violet-200'}`}>
                    {lecture.status === 'PROCESSING' ? 'Step 1 of 2' : 'Step 2 of 2'}
                  </span>
                </div>

                <div className="p-6 flex flex-col gap-6 flex-1">

                  {/* Big progress percentage */}
                  <div className="flex items-end gap-3">
                    <span className={`text-5xl font-black tabular-nums ${lecture.status === 'PROCESSING' ? 'text-blue-600' : 'text-violet-600'}`}>{pct}%</span>
                    <div className="mb-1.5">
                      <p className="text-[15px] font-semibold text-slate-700">
                        {lecture.status === 'PROCESSING' ? 'Inserting Chunks' : 'Generating Embeddings'}
                      </p>
                      <p className="text-[13px] text-slate-400">
                        {lecture.progressCurrent.toLocaleString()} of {lecture.progressTotal.toLocaleString()} chunks
                      </p>
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div>
                    <div className="w-full bg-slate-100 rounded-full h-3 overflow-hidden">
                      <div
                        className={`h-3 rounded-full transition-all duration-700 ${lecture.status === 'PROCESSING' ? 'bg-gradient-to-r from-blue-400 to-blue-600' : 'bg-gradient-to-r from-violet-400 to-violet-600'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="flex justify-between mt-1.5">
                      <span className="text-[12px] text-slate-400">0</span>
                      <span className="text-[12px] text-slate-400">{lecture.progressTotal.toLocaleString()} chunks</span>
                    </div>
                  </div>

                  {/* Pipeline steps */}
                  <div className="border border-slate-100 rounded-xl overflow-hidden">
                    <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-100">
                      <span className="text-[12px] font-bold text-slate-400 uppercase tracking-wider">Pipeline Steps</span>
                    </div>
                    <div className="divide-y divide-slate-100">
                      {STEPS.map((step, idx) => {
                        const isDone   = idx < activeStep;
                        const isActive = idx === activeStep;
                        return (
                          <div key={step.key} className={`flex items-center gap-3 px-4 py-3 ${isActive ? (lecture.status === 'PROCESSING' ? 'bg-blue-50' : 'bg-violet-50') : ''}`}>
                            <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-[13px]
                              ${isDone   ? 'bg-emerald-100 text-emerald-600' :
                                isActive ? (lecture.status === 'PROCESSING' ? 'bg-blue-100 text-blue-600' : 'bg-violet-100 text-violet-600') :
                                           'bg-slate-100 text-slate-400'}`}>
                              {isDone   ? <i className="fas fa-check" /> :
                               isActive ? <i className={`${step.icon} animate-pulse`} /> :
                                          <i className={step.icon} />}
                            </div>
                            <span className={`text-[14px] font-medium flex-1 ${isDone ? 'text-slate-500 line-through decoration-slate-300' : isActive ? 'text-slate-800' : 'text-slate-400'}`}>
                              {step.label}
                            </span>
                            <span className={`text-[12px] font-semibold px-2 py-0.5 rounded-full
                              ${isDone   ? 'bg-emerald-50 text-emerald-600' :
                                isActive ? (lecture.status === 'PROCESSING' ? 'bg-blue-50 text-blue-600' : 'bg-violet-50 text-violet-600') :
                                           'bg-slate-50 text-slate-400'}`}>
                              {isDone ? 'Done' : isActive ? 'Active' : 'Pending'}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Estimated time (only for embedding) */}
                  {lecture.status === 'EMBEDDING' && (
                    <div className="flex items-center gap-3 bg-violet-50 border border-violet-100 rounded-xl px-4 py-3">
                      <i className="fas fa-clock text-violet-500 text-[16px]" />
                      <div>
                        <p className="text-[13px] font-semibold text-violet-800">Estimated time remaining</p>
                        <p className="text-[20px] font-black text-violet-700">
                          {estLabel ?? 'Calculating…'}
                        </p>
                        {chunksPerSec && (
                          <p className="text-[11px] text-violet-400 mt-0.5">{Math.round(chunksPerSec)} chunks/sec</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        }

        return (
          <div className="grid grid-cols-2 gap-5 mb-5">
            {detailsCard}
            {uploadCard}
          </div>
        );
      })()}

      {/* Dataset preview — only shown when READY */}
      {lecture.status === 'READY' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden mt-5">
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/60">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center">
                <i className="fas fa-list-check text-white text-[17px]" />
              </div>
              <span className="text-[16px] font-semibold text-slate-700">Dataset Preview</span>
              {allChunks.length > 0 && (
                <span className="text-[17px] font-semibold text-indigo-600 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded-full">
                  {allChunks.length} Q&A pairs
                </span>
              )}
            </div>
          </div>

          <div className="px-6 pt-4 pb-2">
            <div className="relative">
              <i className="fas fa-search absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-[17px]" />
              <input
                value={chunkSearch}
                onChange={e => { setChunkSearch(e.target.value); setChunkPage(1); }}
                placeholder="Search questions or topics…"
                className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-[17px] text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all"
              />
            </div>
          </div>

          {chunksLoading ? (
            <div className="px-6 py-4 space-y-3">
              {[1,2,3].map(i => <div key={i} className="h-16 bg-slate-100 rounded-xl animate-pulse" />)}
            </div>
          ) : pagedChunks.length === 0 ? (
            <div className="px-6 py-8 text-center text-slate-400 text-[17px]">No Q&A pairs found.</div>
          ) : (
            <div className="divide-y divide-slate-100 px-6 py-2">
              {pagedChunks.map((chunk) => (
                <div key={chunk.id} className="py-4">
                  <div className="flex items-start gap-3">
                    <div className="w-5 h-5 rounded-lg bg-blue-100 flex items-center justify-center shrink-0 mt-0.5">
                      <i className="fas fa-circle-question text-blue-600 text-[17px]" />
                    </div>
                    <div className="flex-1 min-w-0">
                      {chunk.topic && (
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[17px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">{chunk.topic}</span>
                          {chunk.startTime && (
                            <span className="text-[17px] text-slate-400 font-mono">{chunk.startTime}{chunk.endTime ? ` – ${chunk.endTime}` : ''}</span>
                          )}
                        </div>
                      )}
                      <p className="text-[17px] font-semibold text-slate-800 mb-1.5">{chunk.question}</p>
                      <p className="text-[17px] text-slate-500 leading-relaxed line-clamp-3">{chunk.answer}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {chunkPages > 1 && (
            <div className="px-6 py-3 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between">
              <span className="text-[17px] text-slate-400">{filteredChunks.length} pair{filteredChunks.length !== 1 ? 's' : ''}</span>
              <div className="flex items-center gap-1.5">
                <button onClick={() => setChunkPage(p => Math.max(1, p - 1))} disabled={chunkPage === 1}
                  className="w-7 h-7 rounded-lg border border-slate-200 flex items-center justify-center text-slate-500 hover:bg-slate-100 disabled:opacity-30 text-[17px]">
                  <i className="fas fa-chevron-left" />
                </button>
                <span className="text-[17px] text-slate-600 font-medium">{chunkPage} / {chunkPages}</span>
                <button onClick={() => setChunkPage(p => Math.min(chunkPages, p + 1))} disabled={chunkPage === chunkPages}
                  className="w-7 h-7 rounded-lg border border-slate-200 flex items-center justify-center text-slate-500 hover:bg-slate-100 disabled:opacity-30 text-[17px]">
                  <i className="fas fa-chevron-right" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      </div>{/* end centered content */}

      {/* Save success toast */}
      {savedNotif && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 bg-emerald-600 text-white px-5 py-3.5 rounded-2xl shadow-xl animate-fade-in">
          <i className="fas fa-circle-check text-[18px]" />
          <div>
            <p className="text-[15px] font-bold leading-none">Changes saved</p>
            <p className="text-[13px] text-emerald-100 mt-0.5">Lecture details updated successfully.</p>
          </div>
        </div>
      )}
    </div>
  );
}
