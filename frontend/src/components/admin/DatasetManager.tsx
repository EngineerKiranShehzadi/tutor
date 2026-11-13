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

// Plain words in a table cell. A rounded pill around a one-word status is the
// house style of every generated admin template, and the word says it already.
const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  ACTIVE:            { label: 'In use now',   cls: 'font-semibold text-[var(--text)]' },
  SUPERSEDED:        { label: 'Replaced',     cls: 'text-[var(--muted)]' },
  BUILDING:          { label: 'Building',     cls: 'text-[var(--gold)]' },
  READY_TO_ACTIVATE: { label: 'Publishing',   cls: 'text-[var(--gold)]' },
  FAILED:            { label: 'Failed',       cls: 'text-red-700' },
  ARCHIVED:          { label: 'Old',          cls: 'text-[var(--muted2)]' },
};

const apiMessage = (err: unknown, fallback: string): string =>
  (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;

const previewFromError = (err: unknown): DatasetPreview | null =>
  (err as { response?: { status?: number; data?: { data?: { preview?: DatasetPreview } } } })?.response?.data?.data?.preview ?? null;

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

// Build-status polling: every 5 s while a version is building; after a failed
// poll the interval doubles up to 30 s, and a 429 waits as long as the
// server's Retry-After says.
const POLL_MS = 5000;
const MAX_POLL_MS = 30000;
const POLL_ERROR = 'Could not refresh build status — retrying…';

// How long the server asked us to wait (Retry-After, seconds), if it did.
const retryAfterMs = (err: unknown): number | null => {
  const r = (err as { response?: { status?: number; headers?: Record<string, unknown> } })?.response;
  if (r?.status !== 429) return null;
  const secs = Number(r.headers?.['retry-after']);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : null;
};


export function DatasetManager({ lectureId, lectureStatus, onChanged }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<DatasetMode>('MERGE');
  const [file, setFile] = useState<File | null>(null);
  const [extractionWarnings, setExtractionWarnings] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [preview, setPreview] = useState<DatasetPreview | null>(null);
  // The dry run plans the file in both modes; switching mode reads from here
  // instead of uploading and parsing the file again.
  const [previews, setPreviews] = useState<Partial<Record<DatasetMode, DatasetPreview>>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  // Most visits only need to know what is in there. The file picker and the
  // version history are opened when wanted, instead of all of it being on
  // screen at once.
  const [showUpdate,  setShowUpdate]  = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [versions, setVersions] = useState<DatasetVersionInfo[]>([]);
  const [versionsLoaded, setVersionsLoaded] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [exporting, setExporting] = useState(false);
  const lastSeenInFlight = useRef<number | null>(null);

  // Resolves to whether the refresh worked and, after a 429, how long to wait.
  // A failure is shown (never swallowed) and cleared by the next success; it
  // never replaces a different error that is already on screen.
  const loadVersions = useCallback(async (): Promise<{ ok: boolean; waitMs: number | null }> => {
    try {
      const res = await datasetApi.versions(lectureId);
      const list: DatasetVersionInfo[] = res.data?.data?.versions ?? [];
      setVersions(list);
      setVersionsLoaded(true);
      setError(e => (e === POLL_ERROR ? '' : e));
      return { ok: true, waitMs: null };
    } catch (err) {
      setVersionsLoaded(true);
      setError(e => (e && e !== POLL_ERROR ? e : POLL_ERROR));
      return { ok: false, waitMs: retryAfterMs(err) };
    }
  }, [lectureId]);

  useEffect(() => { void loadVersions(); }, [loadVersions, lectureStatus]);

  const inFlight = versions.find(v => IN_FLIGHT.has(v.status)) ?? null;

  // Poll while a build is in flight (backing off after failures); announce how it ended.
  useEffect(() => {
    if (!inFlight) return;
    lastSeenInFlight.current = inFlight.id;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = POLL_MS;
    const tick = async () => {
      const r = await loadVersions();
      if (stopped) return;
      delay = r.ok ? POLL_MS : r.waitMs ?? Math.min(delay * 2, MAX_POLL_MS);
      timer = setTimeout(() => { void tick(); }, delay);
    };
    timer = setTimeout(() => { void tick(); }, delay);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
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
    setPhase('analysing'); setError(''); setNotice(''); setPreview(null); setPreviews({}); setConfirmed(false); setExtractionWarnings([]);
    try {
      const res = await datasetApi.upload(lectureId, f, { mode: m, dryRun: true });
      const data = res.data.data as { preview: DatasetPreview; previews?: Record<DatasetMode, DatasetPreview>; extractionWarnings?: string[] };
      setPreviews(data.previews ?? { [m]: data.preview });
    setExtractionWarnings(data.extractionWarnings ?? []);
      setPreview(data.preview);
      setPhase('preview');
    } catch (err) {
      setError(apiMessage(err, 'Could not analyse the file.'));
      setPhase('idle');
    }
  }, [lectureId]);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!/\.(xlsx|pdf|docx|ppt|pptx|txt|html|htm)$/i.test(f.name)) { setError('Use .xlsx, .pdf, .docx, .ppt, .pptx, .txt or .html files.'); return; }
    if (!f.size) { setError('File is empty. Please select a non-empty file.'); return; }
    setFile(f);
    void analyse(f, mode);
  };

  const changeMode = (m: DatasetMode) => {
    setMode(m);
    if (!file || phase === 'applying') return;
    const known = previews[m];
    if (known && phase === 'preview') {
      setPreview(known); setConfirmed(false); setError('');
    } else {
      void analyse(file, m);
    }
  };

  const reset = () => {
    setFile(null); setPreview(null); setPreviews({}); setPhase('idle'); setConfirmed(false); setExtractionWarnings([]);
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
      if (p) { setPreview(p); setPreviews(all => ({ ...all, [mode]: p })); }   // the server's own removal count wins
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
    <div className="bg-[var(--card)] rounded-card border border-[var(--border)] overflow-hidden" data-testid="dataset-manager">
      {/* Named "Teaching Material", because the list of question and answer
          pairs further down the page is the dataset. Two sections called
          Dataset made the page unreadable. No icon tile: no other admin card
          has one. */}
      <div className="flex items-center justify-between gap-3 px-6 pt-6 pb-1">
        <div className="flex items-center gap-2.5">
          <h2 className="text-h3 font-semibold text-[var(--text)]">Teaching Material</h2>
          {/* The line under this heading already says which version is live. */}
        </div>
        <button
          onClick={doExport}
          disabled={!hasDataset || exporting}
          data-testid="dataset-export"
          className="flex items-center gap-2 px-3.5 py-2 border border-[var(--border)] rounded-control text-label font-semibold text-[var(--text)] hover:bg-[var(--surface)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Download the live dataset with each Q&A's qa_id, edit it, and upload it again"
        >
          <i className="fas fa-file-arrow-down" /> {exporting ? 'Exporting…' : 'Export for Editing'}
        </button>
      </div>

      <div className="p-6 flex flex-col gap-5">
        {/* One line, not two paragraphs. The explanation of how an update
            works belongs with the update, not on top of every visit. */}
        <p className="text-label text-[var(--muted)]">
          What the tutor answers from.{' '}
          {active
            ? <>Version {active.version_no} is live{active.chunk_count ? `, holding ${active.chunk_count.toLocaleString()} question and answer pieces` : ''}.</>
            : <>Nothing uploaded yet, so this lecture&rsquo;s tutor cannot answer anything.</>}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => { if (showUpdate) reset(); setShowUpdate(v => !v); }}
            aria-expanded={showUpdate}
            className="rounded-control bg-[var(--accent)] px-4 py-2 text-caption font-semibold text-white hover:bg-[var(--accent-deep)] transition-colors"
          >
            {showUpdate ? 'Cancel Update' : hasDataset ? 'Update Material' : 'Add Material'}
          </button>
          {versions.length > 0 && (
            <button
              type="button"
              onClick={() => setShowHistory(v => !v)}
              aria-expanded={showHistory}
              className="rounded-control border border-[var(--border)] px-4 py-2 text-caption font-semibold text-[var(--text)] hover:bg-[var(--surface)] transition-colors"
            >
              {showHistory ? 'Hide History' : `History (${versions.length})`}
            </button>
          )}
        </div>

        {notice && (
          <div className="flex items-start gap-2.5 bg-[var(--surface)] border border-[var(--border)] rounded-control px-4 py-3 text-label text-[var(--accent)]" data-testid="dataset-notice">
            <i className="fas fa-circle-check mt-0.5 shrink-0" /> {notice}
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2.5 bg-red-50 border border-red-200 rounded-control px-4 py-3 text-label text-red-700 whitespace-pre-line" data-testid="dataset-error">
            <i className="fas fa-circle-exclamation mt-0.5 shrink-0" /> <span>{error}</span>
          </div>
        )}

        {showUpdate && (
        <>
        <p className="text-caption text-[var(--muted)] leading-relaxed max-w-[78ch]">
          A spreadsheet of questions and answers, or lecture notes as PDF, Word, PowerPoint,
          text or HTML. Students keep using the current material until the new one is ready.
          <br />
          To correct something already in there, press Export for Editing, change that file and
          upload it back. Leave the <code className="font-mono bg-[var(--surface)] px-1 rounded">qa_id</code> column
          alone, it is how rows are matched.
        </p>

        {/* Two plain radio rows. They were a pair of bordered, tinted panels
            with a DEFAULT badge, which is a shape that exists nowhere else in
            the product. */}
        <fieldset className="space-y-3" disabled={busy && phase !== 'preview'}>
          <legend className="text-label font-semibold text-[var(--text)] mb-2">Step 1. What should the new file do?</legend>
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="radio" name="dataset-mode" className="mt-1 accent-[var(--accent)]" checked={mode === 'MERGE'} onChange={() => changeMode('MERGE')} data-testid="dataset-mode-merge" />
            <span className="min-w-0">
              <span className="block text-label text-[var(--text)]">Add to what is already there</span>
              <span className="block text-caption text-[var(--muted)] mt-0.5">New questions are added and matching ones are updated. Nothing is removed.</span>
            </span>
          </label>
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="radio" name="dataset-mode" className="mt-1 accent-[var(--accent)]" checked={mode === 'REPLACE'} onChange={() => changeMode('REPLACE')} data-testid="dataset-mode-replace" />
            <span className="min-w-0">
              <span className="block text-label text-[var(--text)]">Replace everything</span>
              <span className="block text-caption text-[var(--muted)] mt-0.5">Anything not in the new file is deleted. You are shown how many before it happens.</span>
            </span>
          </label>
        </fieldset>

        {/* File picker */}
        <p className="text-label font-semibold text-[var(--text)]">Step 2. Choose the file</p>
        <div className="flex items-center gap-4 flex-wrap -mt-2">
          <input ref={fileRef} type="file" accept=".xlsx,.pdf,.docx,.ppt,.pptx,.txt,.html,.htm" className="hidden" onChange={onFile} data-testid="dataset-file-input" />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            data-testid="dataset-choose-file"
            className="flex items-center gap-2 px-5 py-2.5 bg-[var(--accent)] text-white rounded-control text-label font-semibold hover:bg-[var(--accent-deep)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
          >
            <i className="fas fa-cloud-arrow-up" /> {hasDataset ? 'Choose File' : 'Choose File'}
          </button>
          {file && <span className="text-label text-[var(--muted)] font-mono">{file.name}</span>}
          {phase === 'analysing' && (
            <span className="flex items-center gap-2 text-label text-[var(--muted)]"><span className="w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" /> Checking the file against the live dataset…</span>
          )}
          {inFlight && <span className="text-label text-[var(--muted2)]"><i className="fas fa-lock mr-1" /> Locked while a version is building</span>}
        </div>
        </>
        )}

        {/* Preview */}
        {extractionWarnings.length > 0 && (
            <div role="alert" className="my-3 rounded-control border border-[var(--border)] border-l-[3px] border-l-[var(--gold)] bg-[var(--card)] px-5 py-4 text-caption text-[var(--text)]" data-testid="extraction-warnings">
              <b>Some content could not be extracted:</b>
              <ul className="list-disc ml-5 mt-1">{extractionWarnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>
              <p>Scanned pages and diagrams need OCR or text captions. Review before applying.</p>
            </div>
          )}
          {preview && (phase === 'preview' || phase === 'applying') && (
          /* A rule, not another card. This sat inside the Teaching Material
             card and held further cards of its own, three borders deep. */
          <div className="border-t border-[var(--border)] pt-5 mt-1" data-testid="dataset-preview">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-label font-semibold text-[var(--text)]">
                What will happen · {preview.rowsInFile.toLocaleString()} {preview.rowsInFile === 1 ? 'row' : 'rows'} in your file
                {(preview.skippedRows ?? 0) > 0 && <> · <span className="text-[var(--gold)]" data-testid="preview-rows-used">{(preview.rowsUsed ?? preview.rowsInFile).toLocaleString()} used</span></>}
              </span>
              <button onClick={reset} className="text-caption text-[var(--muted)] hover:text-[var(--text)]" data-testid="dataset-cancel">Cancel</button>
            </div>
            <div className="pt-4 flex flex-col gap-4">
              {/* One sentence. Four figures in blocks meant two of them read
                  "0", which is a number nobody needs to be shown. */}
              <p className="text-label text-[var(--text)] leading-relaxed">
                {preview.added > 0 && (
                  <span data-testid="preview-added">Adds <b>{preview.added.toLocaleString()}</b> new {preview.added === 1 ? 'question' : 'questions'}. </span>
                )}
                {preview.updated > 0 && (
                  <span data-testid="preview-updated">Updates <b>{preview.updated.toLocaleString()}</b> existing {preview.updated === 1 ? 'question' : 'questions'}. </span>
                )}
                {preview.mode === 'REPLACE' && preview.removed > 0 && (
                  <span data-testid="preview-removed">Deletes <b className="text-red-700">{preview.removed.toLocaleString()}</b> that {preview.removed === 1 ? 'is' : 'are'} not in the file. </span>
                )}
                {preview.mode === 'MERGE' && (preview.carriedOver + preview.unchanged) > 0 && (
                  <span data-testid="preview-kept">The other <b>{(preview.carriedOver + preview.unchanged).toLocaleString()}</b> stay as they are. </span>
                )}
                {preview.mode === 'REPLACE' && preview.unchanged > 0 && (
                  <span data-testid="preview-unchanged"><b>{preview.unchanged.toLocaleString()}</b> stay as they are. </span>
                )}
              </p>
              <p className="text-caption text-[var(--muted)]">
                {preview.chunksToEmbed === 0
                  ? 'Nothing new to prepare, so this will be quick.'
                  : <>Preparing {preview.chunksToEmbed.toLocaleString()} new {preview.chunksToEmbed === 1 ? 'piece' : 'pieces'} takes a few minutes.</>}
              </p>

              {preview.reembeddedForModel > 0 && (
                <p className="text-caption text-[var(--gold)]" data-testid="preview-reembedded">
                  {preview.reembeddedForModel} Q&amp;A(s) re-embedded because the embedding model changed
                </p>
              )}

              {(preview.skippedRows ?? 0) > 0 && (
                <div className="bg-[var(--card)] border border-[var(--border)] border-l-[3px] border-l-[var(--gold)] rounded-control px-5 py-4 flex flex-col gap-2" data-testid="dataset-skipped-warning">
                  <p className="text-label text-[var(--text)]">
                    <b>{preview.skippedRows}</b> row(s) will be ignored because the question or answer cell is empty. Fill them in and upload again if they should be included.
                  </p>
                  <ul className="text-caption text-[var(--text)] list-disc pl-5 space-y-0.5">
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
                <div className="bg-[var(--card)] border border-[var(--border)] border-l-[3px] border-l-[var(--gold)] rounded-control px-5 py-4 flex flex-col gap-2" data-testid="dataset-truncated-warning">
                  <p className="text-label text-[var(--text)]">
                    <b>{preview.truncatedRows}</b> answer(s) are too long: only the first part of each will be searchable, the rest is dropped. Shorten or split these answers to keep all of it.
                  </p>
                  <ul className="text-caption text-[var(--text)] list-disc pl-5 space-y-0.5">
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
                <div className="bg-[var(--card)] border border-[var(--border)] border-l-[3px] border-l-[var(--gold)] rounded-control px-5 py-4 flex flex-col gap-2" data-testid="dataset-duplicate-warning">
                  <p className="text-label text-[var(--text)]">
                    {preview.possibleDuplicateCount === 1
                      ? 'One question looks like a reworded copy of one already there. Both will be kept.'
                      : `${preview.possibleDuplicateCount} questions look like reworded copies of ones already there. Both of each will be kept.`}
                  </p>
                  {preview.possibleDuplicateCount <= 3 && (
                    <ul className="text-caption text-[var(--muted)] list-disc pl-5 space-y-1.5">
                      {preview.possibleDuplicates.slice(0, 3).map(d => (
                        <li key={`${d.sheetRow}-${d.existingQaId}`}>
                          <span className="text-[var(--text)]">{d.newQuestion}</span>
                          <br />is close to: {d.existingQuestion}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {noChanges && (
                <div className="bg-[var(--surface)] border border-[var(--border)] rounded-control px-4 py-3 text-label text-[var(--muted)]" data-testid="dataset-no-changes">
                  This file matches the live dataset — there is nothing to update.
                </div>
              )}

              {needsConfirm && (
                /* The qa_id hashes were shown beside each question. They mean
                   nothing to the person reading, and they pushed the question
                   itself off to the right. Five examples, not ten. */
                <div className="bg-[var(--card)] border border-[var(--border)] border-l-[3px] border-l-red-600 rounded-control px-5 py-4 flex flex-col gap-2" data-testid="dataset-removal-warning">
                  <p className="text-label font-semibold text-[var(--text)]">
                    {preview.removed.toLocaleString()} {preview.removed === 1 ? 'question' : 'questions'} will be deleted.
                  </p>
                  {/* Five examples out of four hundred says nothing and takes
                      seven lines to say it. A short list is worth reading, so
                      it is shown; a long one is not. */}
                  {preview.removed <= 5 && (
                    <ul className="text-caption text-[var(--muted)] list-disc pl-5 space-y-0.5">
                      {preview.removedSamples.slice(0, 5).map(r => <li key={r.qaId}>{r.question}</li>)}
                    </ul>
                  )}
                  <p className="text-caption text-[var(--muted)]">You can go back to the current version afterwards.</p>
                  <label className="flex items-start gap-2 text-label text-[var(--text)] cursor-pointer mt-1">
                    <input type="checkbox" className="mt-1 accent-[var(--accent)]" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} data-testid="dataset-confirm-removal" />
                    I understand that {preview.removed.toLocaleString()} {preview.removed === 1 ? 'question' : 'questions'} will be deleted.
                  </label>
                </div>
              )}

              <div className="flex items-center gap-3">
                <button
                  onClick={apply}
                  disabled={!canApply}
                  data-testid="dataset-apply"
                  className="flex items-center gap-2 px-5 py-2.5 rounded-control text-label font-semibold text-white bg-[var(--accent)] hover:bg-[var(--accent-deep)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {phase === 'applying'
                    ? <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Applying…</>
                    : <><i className="fas fa-check" /> {hasDataset ? 'Apply update' : 'Upload dataset'}</>}
                </button>
                {needsConfirm && !confirmed && <span className="text-caption text-[var(--muted2)]">Tick the confirmation to continue</span>}
              </div>
            </div>
          </div>
        )}

        {/* Build progress / errors */}
        {inFlight && (
          <div className={`rounded-card border border-[var(--border)] border-l-[3px] bg-[var(--card)] px-5 py-4 ${waiting ? 'border-l-[var(--gold)]' : 'border-l-[var(--accent)]'}`} data-testid="dataset-progress">
            <div className="flex items-center justify-between mb-2">
              <span className="text-label font-semibold text-[var(--text)]">
                <i className={`fas ${waiting ? 'fa-pause' : 'fa-brain fa-spin'} mr-2 ${waiting ? 'text-[var(--gold)]' : 'text-[var(--accent)]'}`} />
                Building version {inFlight.version_no} {inFlight.status === 'READY_TO_ACTIVATE' ? '· publishing…' : ''}
              </span>
              <span className="flex items-center gap-3">
                <span className="text-h3 font-semibold tabular-nums text-[var(--text)]" data-testid="dataset-progress-pct">{pct}%</span>
                <button
                  onClick={() => setCancelOpen(true)}
                  disabled={cancelling}
                  data-testid="cancel-build-btn"
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-[var(--border)] bg-[var(--card)] rounded-control text-caption font-semibold text-[var(--text)] hover:bg-[var(--surface)] disabled:opacity-40"
                >
                  <i className="fas fa-stop" /> Cancel update
                </button>
              </span>
            </div>
            <div className="w-full bg-[var(--card)]/80 rounded-full h-2.5 overflow-hidden border border-white">
              <div className={`h-2.5 rounded-full transition-all duration-500 ${waiting ? 'bg-[var(--gold)]' : 'bg-[var(--accent)]'}`} style={{ width: `${pct}%` }} />
            </div>
            <p className="text-caption text-[var(--muted)] mt-2">
              {Math.max(0, inFlight.to_embed - Number(inFlight.pending_count))} of {inFlight.to_embed} new chunk(s) embedded.
              {' '}<b>The previous version{active ? ` (v${active.version_no})` : ''} is still live for students.</b>
            </p>
            {inFlight.last_error && (
              <p className={`text-caption mt-1.5 font-medium ${waiting ? 'text-[var(--gold)]' : 'text-red-700'}`} data-testid="dataset-progress-error">
                <i className="fas fa-circle-exclamation mr-1.5" />{inFlight.last_error}
                {waiting && ' — it will resume by itself, no restart needed.'}
              </p>
            )}
          </div>
        )}

        {/* Versions — opened from History, so the table is not on screen on
            every visit. */}
        {showHistory && (
        <div>
          <div className="flex items-center justify-between gap-3 mb-2">
            <div>
              <span className="text-caption font-semibold text-[var(--muted)]">Saved versions</span>
              <p className="text-caption text-[var(--muted2)] mt-0.5">Every upload is kept. Live is the one students are using now.</p>
            </div>
            {previous && (
              <button
                onClick={() => setRollbackOpen(true)}
                disabled={busy}
                data-testid="rollback-btn"
                className="flex items-center gap-1.5 px-3 py-1.5 border border-[var(--border)] rounded-control text-label font-semibold text-[var(--text)] hover:bg-[var(--surface)] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <i className="fas fa-rotate-left" /> Go Back to Version {previous.version_no}
              </button>
            )}
          </div>
          {!versionsLoaded ? (
            <div className="h-10 bg-[var(--surface)] rounded-control animate-pulse" />
          ) : versions.length === 0 ? (
            <p className="text-label text-[var(--muted2)]" data-testid="versions-empty">No dataset versions yet.</p>
          ) : (
            <div className="overflow-x-auto border border-[var(--border)] rounded-control">
              <table className="w-full text-left text-label" data-testid="versions-table">
                <thead className="bg-[var(--surface)] text-caption text-[var(--muted)]">
                  <tr>
                    {/* The standard columns of a version history. Only
                        "Chunks" is renamed, because that is an internal word. */}
                    <th className="px-4 py-2.5">Version</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5">Type</th>
                    <th className="px-4 py-2.5">File</th><th className="px-4 py-2.5">Changes</th><th className="px-4 py-2.5">Questions</th><th className="px-4 py-2.5">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {versions.map(v => {
                    const b = STATUS_BADGE[v.status] ?? STATUS_BADGE.ARCHIVED;
                    const st = v.stats ?? {};
                    return (
                      <tr key={v.id} data-testid={`version-row-${v.version_no}`} data-status={v.status}>
                        <td className="px-4 py-2.5 font-semibold text-[var(--text)]">v{v.version_no}</td>
                        <td className="px-4 py-2.5">
                          <span className={`text-caption ${b.cls}`}>{b.label}</span>
                          {v.status === 'FAILED' && v.last_error && <div className="text-caption text-red-700 mt-1 max-w-[280px]">{v.last_error}</div>}
                        </td>
                        <td className="px-4 py-2.5 text-[var(--muted)]">{v.mode === 'REPLACE' ? 'Replaced' : 'Added'}</td>
                        {/* Two of these values are not uploads: one is the
                            automatic rebuild after an embedding model change,
                            the other is the dataset that existed before
                            versions were recorded. */}
                        <td className="px-4 py-2.5 text-[var(--muted)] max-w-[220px] truncate" title={v.source_filename ?? ''}>
                          {!v.source_filename ? '—'
                            : v.source_filename.startsWith('reembed') ? 'Rebuilt for a new model'
                            : v.source_filename.includes('backfill') ? 'Added before versions were kept'
                            : v.source_filename}
                        </td>
                        <td className="px-4 py-2.5 text-[var(--muted)] whitespace-nowrap">
                          {(st as { backfill?: boolean }).backfill
                            ? <span className="text-[var(--muted2)]">First upload</span>
                            : [
                                (st.added ?? 0) > 0 ? `${st.added} added` : null,
                                (st.updated ?? 0) > 0 ? `${st.updated} updated` : null,
                                (st.removed ?? 0) > 0 ? `${st.removed} deleted` : null,
                              ].filter(Boolean).join(', ') || 'No change'}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums text-[var(--muted)]">{Number(v.chunk_count).toLocaleString()}</td>
                        <td className="px-4 py-2.5 text-[var(--muted)] whitespace-nowrap">{fmt(v.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        )}
      </div>

      {/* Cancel confirmation */}
      {cancelOpen && inFlight && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(22,26,31,0.45)] p-4" role="dialog" aria-modal="true" data-testid="cancel-dialog">
          <div className="bg-[var(--card)] rounded-card shadow-2xl max-w-md w-full p-6">
            <h3 className="text-h3 font-bold text-[var(--text)] mb-2">Cancel the update to version {inFlight.version_no}?</h3>
            <ul className="text-label text-[var(--muted)] list-disc pl-5 space-y-1.5 mb-5">
              <li>The new version is stopped and marked as failed; its half-built data is removed.</li>
              <li>{active ? <>Students keep getting answers from <b>v{active.version_no}</b>, unchanged.</> : <>This lecture has no live dataset yet, so it stays unavailable until you upload again.</>}</li>
              <li>You can upload a file or switch versions again right away.</li>
            </ul>
            <div className="flex justify-end gap-2.5">
              <button onClick={() => setCancelOpen(false)} className="px-4 py-2 border border-[var(--border)] rounded-control text-label font-semibold text-[var(--muted)] hover:bg-[var(--surface)]" data-testid="cancel-dismiss">Keep building</button>
              <button onClick={doCancel} disabled={cancelling} className="px-4 py-2 bg-red-600 text-white rounded-control text-label font-semibold hover:bg-red-700 disabled:opacity-60" data-testid="cancel-confirm">
                {cancelling ? 'Cancelling…' : 'Cancel update'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rollback confirmation */}
      {rollbackOpen && active && previous && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(22,26,31,0.45)] p-4" role="dialog" aria-modal="true" data-testid="rollback-dialog">
          <div className="bg-[var(--card)] rounded-card shadow-2xl max-w-md w-full p-6">
            <h3 className="text-h3 font-bold text-[var(--text)] mb-2">Switch to version #{previous.version_no}?</h3>
            <ul className="text-label text-[var(--muted)] list-disc pl-5 space-y-1.5 mb-5">
              <li>Students will immediately get answers from <b>v{previous.version_no}</b> (from {fmt(previous.created_at)}).</li>
              <li>Version {active.version_no} becomes the previous version — you can switch back again.</li>
              <li>Cached answers from v{active.version_no} stop being used; those of v{previous.version_no} become valid again.</li>
              <li>Existing chat history and its source links are not affected.</li>
            </ul>
            <div className="flex justify-end gap-2.5">
              <button onClick={() => setRollbackOpen(false)} className="px-4 py-2 border border-[var(--border)] rounded-control text-label font-semibold text-[var(--muted)] hover:bg-[var(--surface)]" data-testid="rollback-cancel">Cancel</button>
              <button onClick={doRollback} disabled={rollingBack} className="px-4 py-2 bg-[var(--accent)] text-white rounded-control text-label font-semibold hover:bg-[var(--accent-deep)] disabled:opacity-60" data-testid="rollback-confirm">
                {rollingBack ? 'Switching…' : `Switch to version #${previous.version_no}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
