'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { datasetApi, DatasetMode, DatasetPreview, DatasetVersionInfo } from '@/lib/api';

// Dataset management for one lecture: upload (Merge by default, Replace only on
// explicit confirmation), a preview of exactly what an upload would change,
// build progress/errors, export with qa_id, the version list and rollback.
// The backend keeps serving the current dataset until a new version is fully
// embedded and validated, so nothing here can take the AI tutor offline.

interface Props {
  lectureId: number;
  lectureStatus: string;
  onChanged: () => void;
}

type Phase = 'idle' | 'analysing' | 'preview' | 'applying';

const IN_FLIGHT = new Set(['BUILDING', 'READY_TO_ACTIVATE']);

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  ACTIVE:            { label: 'Live',      cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  SUPERSEDED:        { label: 'Previous',  cls: 'bg-slate-50 text-slate-600 border-slate-200' },
  BUILDING:          { label: 'Building',  cls: 'bg-violet-50 text-violet-700 border-violet-200' },
  READY_TO_ACTIVATE: { label: 'Publishing', cls: 'bg-violet-50 text-violet-700 border-violet-200' },
  FAILED:            { label: 'Failed',    cls: 'bg-red-50 text-red-700 border-red-200' },
  ARCHIVED:          { label: 'Archived',  cls: 'bg-slate-50 text-slate-400 border-slate-200' },
};

const apiMessage = (err: unknown, fallback: string): string =>
  (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;

const previewFromError = (err: unknown): DatasetPreview | null =>
  (err as { response?: { status?: number; data?: { data?: { preview?: DatasetPreview } } } })?.response?.data?.data?.preview ?? null;

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

function Tile({ label, value, tone, testId }: { label: string; value: number; tone: string; testId: string }) {
  return (
    <div className={`rounded-xl border px-4 py-3 ${tone}`} data-testid={testId}>
      <div className="text-2xl font-black tabular-nums leading-none">{value.toLocaleString()}</div>
      <div className="text-[12px] font-semibold uppercase tracking-wide mt-1.5 opacity-80">{label}</div>
    </div>
  );
}

export function DatasetManager({ lectureId, lectureStatus, onChanged }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<DatasetMode>('MERGE');
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [preview, setPreview] = useState<DatasetPreview | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  const [versions, setVersions] = useState<DatasetVersionInfo[]>([]);
  const [versionsLoaded, setVersionsLoaded] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [exporting, setExporting] = useState(false);
  const lastSeenInFlight = useRef<number | null>(null);

  const loadVersions = useCallback(async () => {
    try {
      const res = await datasetApi.versions(lectureId);
      const list: DatasetVersionInfo[] = res.data?.data?.versions ?? [];
      setVersions(list);
      setVersionsLoaded(true);
      return list;
    } catch {
      setVersionsLoaded(true);
      return null;
    }
  }, [lectureId]);

  useEffect(() => { void loadVersions(); }, [loadVersions, lectureStatus]);

  const inFlight = versions.find(v => IN_FLIGHT.has(v.status)) ?? null;

  // Poll while a build is in flight; announce how it ended.
  useEffect(() => {
    if (!inFlight) return;
    lastSeenInFlight.current = inFlight.id;
    const t = setInterval(() => { void loadVersions(); }, 2500);
    return () => clearInterval(t);
  }, [inFlight?.id, loadVersions]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (inFlight || lastSeenInFlight.current === null) return;
    const finished = versions.find(v => v.id === lastSeenInFlight.current);
    if (!finished) return;
    lastSeenInFlight.current = null;
    if (finished.status === 'ACTIVE') setNotice(`Version ${finished.version_no} is now live.`);
    else if (finished.status === 'FAILED') setError(`Version ${finished.version_no} ${/^Cancelled/.test(finished.last_error ?? '') ? 'was cancelled' : `failed: ${finished.last_error ?? 'unknown error'}`}. The previous dataset is still live.`);
    onChanged();
  }, [inFlight, versions]); // eslint-disable-line react-hooks/exhaustive-deps

  const analyse = useCallback(async (f: File, m: DatasetMode) => {
    setPhase('analysing'); setError(''); setNotice(''); setPreview(null); setConfirmed(false);
    try {
      const res = await datasetApi.upload(lectureId, f, { mode: m, dryRun: true });
      setPreview(res.data.data.preview as DatasetPreview);
      setPhase('preview');
    } catch (err) {
      setError(apiMessage(err, 'Could not analyse the file.'));
      setPhase('idle');
    }
  }, [lectureId]);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.xlsx')) { setError('Only .xlsx files are accepted.'); return; }
    setFile(f);
    void analyse(f, mode);
  };

  const changeMode = (m: DatasetMode) => {
    setMode(m);
    if (file && phase !== 'applying') void analyse(file, m);
  };

  const reset = () => {
    setFile(null); setPreview(null); setPhase('idle'); setConfirmed(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const apply = async () => {
    if (!file || !preview) return;
    setPhase('applying'); setError('');
    try {
      const res = await datasetApi.upload(lectureId, file, {
        mode,
        confirmRemovals: preview.removed > 0 ? preview.removed : undefined,
      });
      setNotice(res.data.message);
      reset();
      await loadVersions();
      onChanged();
    } catch (err) {
      const p = previewFromError(err);
      if (p) setPreview(p);               // the server's own removal count wins
      setError(apiMessage(err, 'Upload failed.'));
      setPhase('preview');
    }
  };

  const doExport = async () => {
    setExporting(true); setError('');
    try {
      const res = await datasetApi.exportXlsx(lectureId);
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement('a');
      a.href = url; a.download = `lecture-${lectureId}-dataset.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(apiMessage(err, 'Export failed.'));
    } finally {
      setExporting(false);
    }
  };

  const doRollback = async () => {
    setRollingBack(true); setError(''); setNotice('');
    try {
      const res = await datasetApi.rollback(lectureId);
      setNotice(res.data.message);
      setRollbackOpen(false);
      await loadVersions();
      onChanged();
    } catch (err) {
      setError(apiMessage(err, 'Rollback failed.'));
      setRollbackOpen(false);
    } finally {
      setRollingBack(false);
    }
  };

  const doCancel = async () => {
    setCancelling(true); setError(''); setNotice('');
    try {
      const res = await datasetApi.cancel(lectureId);
      lastSeenInFlight.current = null;   // the notice below replaces the "finished" message
      setNotice(res.data.message);
      setCancelOpen(false);
      await loadVersions();
      onChanged();
    } catch (err) {
      setError(apiMessage(err, 'Cancel failed.'));
      setCancelOpen(false);
      await loadVersions();
    } finally {
      setCancelling(false);
    }
  };

  const active = versions.find(v => v.status === 'ACTIVE') ?? null;
  const previous = versions.find(v => v.status === 'SUPERSEDED') ?? null;   // list is newest-first
  const hasDataset = !!active;
  const firstUploadRunning = !hasDataset && ['DATASET_UPLOADED', 'PROCESSING', 'EMBEDDING'].includes(lectureStatus);
  const busy = phase === 'analysing' || phase === 'applying' || !!inFlight || firstUploadRunning;
  const noChanges = !!preview && preview.added === 0 && preview.updated === 0 && preview.removed === 0 && !(preview.reembeddedForModel > 0);
  const needsConfirm = !!preview && preview.removed > 0;
  const canApply = phase === 'preview' && !!preview && !noChanges && (!needsConfirm || confirmed);

  const pct = inFlight && inFlight.to_embed > 0
    ? Math.min(100, Math.round(((inFlight.to_embed - Number(inFlight.pending_count)) / inFlight.to_embed) * 100))
    : inFlight ? 100 : 0;
  const waiting = !!inFlight && /unavailable|waiting/i.test(inFlight.last_error ?? '');

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden" data-testid="dataset-manager">
      <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-slate-100 bg-slate-50/60">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-emerald-600 flex items-center justify-center">
            <i className="fas fa-table text-white text-[15px]" />
          </div>
          <span className="text-[16px] font-semibold text-slate-700">Dataset</span>
          {active && (
            <span className="text-[13px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full" data-testid="live-version-badge">
              Live: version {active.version_no}
            </span>
          )}
        </div>
        <button
          onClick={doExport}
          disabled={!hasDataset || exporting}
          data-testid="dataset-export"
          className="flex items-center gap-2 px-3.5 py-2 border border-slate-200 rounded-xl text-[15px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Download the live dataset with each Q&A's qa_id, edit it, and upload it again"
        >
          <i className="fas fa-file-arrow-down" /> {exporting ? 'Exporting…' : 'Export (.xlsx with qa_id)'}
        </button>
      </div>

      <div className="p-6 flex flex-col gap-5">
        <p className="text-[15px] text-slate-500 leading-relaxed">
          Upload a Q&amp;A spreadsheet. The AI tutor keeps answering from the live version until the new one is fully embedded and validated.
          To edit existing rows, export first and keep the <code className="font-mono text-[13px] bg-slate-100 px-1 rounded">qa_id</code> column.
        </p>

        {notice && (
          <div className="flex items-start gap-2.5 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-[15px] text-emerald-800" data-testid="dataset-notice">
            <i className="fas fa-circle-check mt-0.5 shrink-0" /> {notice}
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2.5 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-[15px] text-red-700 whitespace-pre-line" data-testid="dataset-error">
            <i className="fas fa-circle-exclamation mt-0.5 shrink-0" /> <span>{error}</span>
          </div>
        )}

        {/* Mode */}
        <fieldset className="grid sm:grid-cols-2 gap-3" disabled={busy && phase !== 'preview'}>
          <legend className="text-[12px] font-bold uppercase tracking-wider text-slate-400 mb-2">Update mode</legend>
          <label className={`cursor-pointer rounded-xl border px-4 py-3 ${mode === 'MERGE' ? 'border-indigo-400 bg-indigo-50/60 ring-2 ring-indigo-100' : 'border-slate-200 hover:bg-slate-50'}`}>
            <input type="radio" name="dataset-mode" className="sr-only" checked={mode === 'MERGE'} onChange={() => changeMode('MERGE')} data-testid="dataset-mode-merge" />
            <div className="text-[15px] font-semibold text-slate-800">Merge <span className="text-[12px] font-bold text-indigo-600 ml-1">DEFAULT</span></div>
            <div className="text-[13px] text-slate-500 mt-0.5">Adds new rows and updates matching ones. Rows missing from the file are kept — nothing is deleted.</div>
          </label>
          <label className={`cursor-pointer rounded-xl border px-4 py-3 ${mode === 'REPLACE' ? 'border-red-300 bg-red-50/50 ring-2 ring-red-100' : 'border-slate-200 hover:bg-slate-50'}`}>
            <input type="radio" name="dataset-mode" className="sr-only" checked={mode === 'REPLACE'} onChange={() => changeMode('REPLACE')} data-testid="dataset-mode-replace" />
            <div className="text-[15px] font-semibold text-slate-800">Replace</div>
            <div className="text-[13px] text-slate-500 mt-0.5">The file becomes the whole dataset. Rows missing from it are removed — you will see how many first.</div>
          </label>
        </fieldset>

        {/* File picker */}
        <div className="flex items-center gap-4 flex-wrap">
          <input ref={fileRef} type="file" accept=".xlsx" className="hidden" onChange={onFile} data-testid="dataset-file-input" />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            data-testid="dataset-choose-file"
            className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 text-white rounded-xl text-[15px] font-semibold hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
          >
            <i className="fas fa-cloud-arrow-up" /> {hasDataset ? 'Choose updated .xlsx' : 'Choose dataset .xlsx'}
          </button>
          {file && <span className="text-[14px] text-slate-600 font-mono">{file.name}</span>}
          {phase === 'analysing' && (
            <span className="flex items-center gap-2 text-[14px] text-slate-500"><span className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" /> Checking the file against the live dataset…</span>
          )}
          {inFlight && <span className="text-[14px] text-slate-400"><i className="fas fa-lock mr-1" /> Locked while a version is building</span>}
        </div>

        {/* Preview */}
        {preview && (phase === 'preview' || phase === 'applying') && (
          <div className="border border-slate-200 rounded-2xl overflow-hidden" data-testid="dataset-preview">
            <div className="px-5 py-3 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
              <span className="text-[14px] font-semibold text-slate-700">
                What this {preview.mode === 'REPLACE' ? 'replace' : 'merge'} will do · {preview.rowsInFile.toLocaleString()} rows in file
                {(preview.skippedRows ?? 0) > 0 && <> · <span className="text-amber-700" data-testid="preview-rows-used">{(preview.rowsUsed ?? preview.rowsInFile).toLocaleString()} used</span></>}
              </span>
              <button onClick={reset} className="text-[13px] text-slate-500 hover:text-slate-800" data-testid="dataset-cancel">Cancel</button>
            </div>
            <div className="p-5 flex flex-col gap-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Tile label="Added" value={preview.added} tone="bg-emerald-50 border-emerald-200 text-emerald-800" testId="preview-added" />
                <Tile label="Updated" value={preview.updated} tone="bg-amber-50 border-amber-200 text-amber-800" testId="preview-updated" />
                <Tile label="Unchanged" value={preview.unchanged} tone="bg-slate-50 border-slate-200 text-slate-700" testId="preview-unchanged" />
                {preview.mode === 'MERGE'
                  ? <Tile label="Kept (not in file)" value={preview.carriedOver} tone="bg-sky-50 border-sky-200 text-sky-800" testId="preview-kept" />
                  : <Tile label="Removed" value={preview.removed} tone={preview.removed > 0 ? 'bg-red-50 border-red-300 text-red-800' : 'bg-slate-50 border-slate-200 text-slate-700'} testId="preview-removed" />}
              </div>
              <p className="text-[13px] text-slate-500">
                {preview.chunksToEmbed === 0
                  ? 'No embedding work needed — existing embeddings are reused.'
                  : <>Only <b>{preview.chunksToEmbed}</b> chunk(s) need new embeddings; {preview.chunksReused + preview.chunksCopied} existing embedding(s) are reused.</>}
              </p>

              {preview.reembeddedForModel > 0 && (
                <p className="text-[13px] text-amber-700" data-testid="preview-reembedded">
                  {preview.reembeddedForModel} Q&amp;A(s) re-embedded because the embedding model changed
                </p>
              )}

              {(preview.skippedRows ?? 0) > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex flex-col gap-2" data-testid="dataset-skipped-warning">
                  <p className="text-[14px] text-amber-900">
                    <b>{preview.skippedRows}</b> row(s) will be ignored because the question or answer cell is empty. Fill them in and upload again if they should be included.
                  </p>
                  <ul className="text-[13px] text-amber-900 list-disc pl-5 space-y-0.5">
                    {(preview.skippedSamples ?? []).map(r => (
                      <li key={r.sheetRow}>Row {r.sheetRow}: {r.reason === 'EMPTY_QUESTION' ? 'empty question' : 'empty answer'}</li>
                    ))}
                    {(preview.skippedRows ?? 0) > (preview.skippedSamples?.length ?? 0) && (
                      <li>…and {(preview.skippedRows ?? 0) - (preview.skippedSamples?.length ?? 0)} more</li>
                    )}
                  </ul>
                </div>
              )}

              {(preview.truncatedRows ?? 0) > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex flex-col gap-2" data-testid="dataset-truncated-warning">
                  <p className="text-[14px] text-amber-900">
                    <b>{preview.truncatedRows}</b> answer(s) are too long: only the first part of each will be searchable, the rest is dropped. Shorten or split these answers to keep all of it.
                  </p>
                  <ul className="text-[13px] text-amber-900 list-disc pl-5 space-y-0.5">
                    {(preview.truncatedSamples ?? []).map(r => (
                      <li key={r.sheetRow}>Row {r.sheetRow}: “{r.question}” — {r.pieces} pieces, first {r.kept} kept</li>
                    ))}
                    {(preview.truncatedRows ?? 0) > (preview.truncatedSamples?.length ?? 0) && (
                      <li>…and {(preview.truncatedRows ?? 0) - (preview.truncatedSamples?.length ?? 0)} more</li>
                    )}
                  </ul>
                </div>
              )}

              {preview.possibleDuplicateCount > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex flex-col gap-2" data-testid="dataset-duplicate-warning">
                  <p className="text-[14px] text-amber-900">
                    These new rows look like edited versions of existing Q&amp;As. With Merge, both will stay live. If this file is your full corrected dataset, use Replace.
                  </p>
                  <ul className="text-[13px] text-amber-900 list-disc pl-5 space-y-1">
                    {preview.possibleDuplicates.map(d => (
                      <li key={`${d.sheetRow}-${d.existingQaId}`}>
                        Row {d.sheetRow}: “{d.newQuestion}” ≈ <span className="font-mono text-[12px]">{d.existingQaId}</span> “{d.existingQuestion}”
                      </li>
                    ))}
                    {preview.possibleDuplicateCount > preview.possibleDuplicates.length && (
                      <li>…and {preview.possibleDuplicateCount - preview.possibleDuplicates.length} more</li>
                    )}
                  </ul>
                </div>
              )}

              {noChanges && (
                <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-[14px] text-slate-600" data-testid="dataset-no-changes">
                  This file matches the live dataset — there is nothing to update.
                </div>
              )}

              {needsConfirm && (
                <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 flex flex-col gap-2" data-testid="dataset-removal-warning">
                  <p className="text-[14px] font-semibold text-red-800">
                    <i className="fas fa-triangle-exclamation mr-1.5" />
                    {preview.removed} existing Q&amp;A(s) are not in this file and will be removed from the new version.
                  </p>
                  <ul className="text-[13px] text-red-700 list-disc pl-5">
                    {preview.removedSamples.map(r => <li key={r.qaId}><span className="font-mono text-[12px]">{r.qaId}</span> — {r.question}</li>)}
                    {preview.removed > preview.removedSamples.length && <li>…and {preview.removed - preview.removedSamples.length} more</li>}
                  </ul>
                  <p className="text-[13px] text-red-700">The previous version is kept, so you can roll back.</p>
                  <label className="flex items-center gap-2 text-[14px] text-red-900 font-medium cursor-pointer">
                    <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} data-testid="dataset-confirm-removal" />
                    I understand that {preview.removed} Q&amp;A(s) will be removed from the live dataset.
                  </label>
                </div>
              )}

              <div className="flex items-center gap-3">
                <button
                  onClick={apply}
                  disabled={!canApply}
                  data-testid="dataset-apply"
                  className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-[15px] font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${preview.mode === 'REPLACE' ? 'bg-red-600 hover:bg-red-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}
                >
                  {phase === 'applying'
                    ? <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Applying…</>
                    : <><i className="fas fa-check" /> {hasDataset ? 'Apply update' : 'Upload dataset'}</>}
                </button>
                {needsConfirm && !confirmed && <span className="text-[13px] text-slate-400">Tick the confirmation to continue</span>}
              </div>
            </div>
          </div>
        )}

        {/* Build progress / errors */}
        {inFlight && (
          <div className={`rounded-2xl border px-5 py-4 ${waiting ? 'border-amber-300 bg-amber-50' : 'border-violet-200 bg-violet-50'}`} data-testid="dataset-progress">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[14px] font-semibold text-slate-800">
                <i className={`fas ${waiting ? 'fa-pause' : 'fa-brain fa-spin'} mr-2 ${waiting ? 'text-amber-600' : 'text-violet-600'}`} />
                Building version {inFlight.version_no} {inFlight.status === 'READY_TO_ACTIVATE' ? '· publishing…' : ''}
              </span>
              <span className="flex items-center gap-3">
                <span className="text-xl font-black tabular-nums text-slate-800" data-testid="dataset-progress-pct">{pct}%</span>
                <button
                  onClick={() => setCancelOpen(true)}
                  disabled={cancelling}
                  data-testid="cancel-build-btn"
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 bg-white rounded-lg text-[13px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                >
                  <i className="fas fa-stop" /> Cancel update
                </button>
              </span>
            </div>
            <div className="w-full bg-white/80 rounded-full h-2.5 overflow-hidden border border-white">
              <div className={`h-2.5 rounded-full transition-all duration-500 ${waiting ? 'bg-amber-400' : 'bg-violet-500'}`} style={{ width: `${pct}%` }} />
            </div>
            <p className="text-[13px] text-slate-600 mt-2">
              {Math.max(0, inFlight.to_embed - Number(inFlight.pending_count))} of {inFlight.to_embed} new chunk(s) embedded.
              {' '}<b>The previous version{active ? ` (v${active.version_no})` : ''} is still live for students.</b>
            </p>
            {inFlight.last_error && (
              <p className={`text-[13px] mt-1.5 font-medium ${waiting ? 'text-amber-800' : 'text-red-700'}`} data-testid="dataset-progress-error">
                <i className="fas fa-circle-exclamation mr-1.5" />{inFlight.last_error}
                {waiting && ' — it will resume by itself, no restart needed.'}
              </p>
            )}
          </div>
        )}

        {/* Versions */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] font-bold uppercase tracking-wider text-slate-400">Versions</span>
            {previous && (
              <button
                onClick={() => setRollbackOpen(true)}
                disabled={busy}
                data-testid="rollback-btn"
                className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 rounded-lg text-[14px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <i className="fas fa-rotate-left" /> Switch to version #{previous.version_no}
              </button>
            )}
          </div>
          {!versionsLoaded ? (
            <div className="h-10 bg-slate-100 rounded-xl animate-pulse" />
          ) : versions.length === 0 ? (
            <p className="text-[14px] text-slate-400" data-testid="versions-empty">No dataset versions yet.</p>
          ) : (
            <div className="overflow-x-auto border border-slate-200 rounded-xl">
              <table className="w-full text-left text-[14px]" data-testid="versions-table">
                <thead className="bg-slate-50 text-[12px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-2.5">Version</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5">Mode</th>
                    <th className="px-4 py-2.5">File</th><th className="px-4 py-2.5">Changes</th><th className="px-4 py-2.5">Chunks</th><th className="px-4 py-2.5">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {versions.map(v => {
                    const b = STATUS_BADGE[v.status] ?? STATUS_BADGE.ARCHIVED;
                    const st = v.stats ?? {};
                    return (
                      <tr key={v.id} data-testid={`version-row-${v.version_no}`} data-status={v.status}>
                        <td className="px-4 py-2.5 font-semibold text-slate-800">v{v.version_no}</td>
                        <td className="px-4 py-2.5">
                          <span className={`text-[12px] font-bold px-2 py-0.5 rounded-full border ${b.cls}`}>{b.label}</span>
                          {v.status === 'FAILED' && v.last_error && <div className="text-[12px] text-red-600 mt-1 max-w-[280px]">{v.last_error}</div>}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">{v.mode === 'REPLACE' ? 'Replace' : 'Merge'}</td>
                        <td className="px-4 py-2.5 text-slate-600 max-w-[200px] truncate" title={v.source_filename ?? ''}>{v.source_filename ?? '—'}</td>
                        <td className="px-4 py-2.5 text-slate-600 whitespace-nowrap">
                          {(st as { backfill?: boolean }).backfill
                            ? <span className="text-slate-400">initial</span>
                            : <>+{st.added ?? 0} ~{st.updated ?? 0} ={st.unchanged ?? 0}{(st.removed ?? 0) > 0 ? ` −${st.removed}` : ''}</>}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums text-slate-600">{Number(v.chunk_count).toLocaleString()}</td>
                        <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap">{fmt(v.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Cancel confirmation */}
      {cancelOpen && inFlight && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" role="dialog" aria-modal="true" data-testid="cancel-dialog">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6">
            <h3 className="text-lg font-bold text-slate-900 mb-2">Cancel the update to version {inFlight.version_no}?</h3>
            <ul className="text-[14px] text-slate-600 list-disc pl-5 space-y-1.5 mb-5">
              <li>The new version is stopped and marked as failed; its half-built data is removed.</li>
              <li>{active ? <>Students keep getting answers from <b>v{active.version_no}</b>, unchanged.</> : <>This lecture has no live dataset yet, so it stays unavailable until you upload again.</>}</li>
              <li>You can upload a file or switch versions again right away.</li>
            </ul>
            <div className="flex justify-end gap-2.5">
              <button onClick={() => setCancelOpen(false)} className="px-4 py-2 border border-slate-200 rounded-xl text-[15px] font-semibold text-slate-600 hover:bg-slate-50" data-testid="cancel-dismiss">Keep building</button>
              <button onClick={doCancel} disabled={cancelling} className="px-4 py-2 bg-red-600 text-white rounded-xl text-[15px] font-semibold hover:bg-red-700 disabled:opacity-60" data-testid="cancel-confirm">
                {cancelling ? 'Cancelling…' : 'Cancel update'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rollback confirmation */}
      {rollbackOpen && active && previous && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" role="dialog" aria-modal="true" data-testid="rollback-dialog">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6">
            <h3 className="text-lg font-bold text-slate-900 mb-2">Switch to version #{previous.version_no}?</h3>
            <ul className="text-[14px] text-slate-600 list-disc pl-5 space-y-1.5 mb-5">
              <li>Students will immediately get answers from <b>v{previous.version_no}</b> (from {fmt(previous.created_at)}).</li>
              <li>Version {active.version_no} becomes the previous version — you can switch back again.</li>
              <li>Cached answers from v{active.version_no} stop being used; those of v{previous.version_no} become valid again.</li>
              <li>Existing chat history and its source links are not affected.</li>
            </ul>
            <div className="flex justify-end gap-2.5">
              <button onClick={() => setRollbackOpen(false)} className="px-4 py-2 border border-slate-200 rounded-xl text-[15px] font-semibold text-slate-600 hover:bg-slate-50" data-testid="rollback-cancel">Cancel</button>
              <button onClick={doRollback} disabled={rollingBack} className="px-4 py-2 bg-slate-900 text-white rounded-xl text-[15px] font-semibold hover:bg-slate-700 disabled:opacity-60" data-testid="rollback-confirm">
                {rollingBack ? 'Switching…' : `Switch to version #${previous.version_no}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
