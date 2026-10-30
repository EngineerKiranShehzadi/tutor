import { createHash, randomBytes } from 'crypto';
import * as XLSX from 'xlsx';
import pool, { query } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { generateEmbedding, generateEmbeddingsBatch, EMBEDDING_MODEL_VERSION, EmbeddingUnavailableError } from './embedding.service';
import { env } from '../config/env';
import { parseExcel, toFileRows, buildChunkPieces, CHUNKING_CONFIG_VERSION } from './chunk.service';
import { getLectureById, updateLectureProgress, updateLectureStatus } from './lecture.service';
import { matchRows, fieldsEqual, findPossibleDuplicates, PossibleDuplicate, ActiveQa, QaFields, FileRow } from './dataset-plan';

// Incremental, resumable, safely-published dataset pipeline.
//
//   prepareDatasetVersion  parse → match rows to the active dataset → build a NEW version
//                          (one transaction; reuses unchanged chunks and their embeddings)
//   finishDatasetVersion   embed only the chunks that still have no vector → validate →
//                          publish (switch the lecture's active version)
//   resumePendingVersions  at server start: continue any version that was mid-build
//
// The lecture keeps answering from its ACTIVE version the whole time. Nothing in
// the active version is ever modified: chunk rows are immutable, a version is a
// set of memberships (dataset_version_chunks), and publishing is a single atomic
// pointer switch (lectures.active_version_id).

export type DatasetMode = 'MERGE' | 'REPLACE';

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const newQaId = (): string => 'qa_' + randomBytes(6).toString('hex');

// A version that keeps failing to finish embedding is given up on after this
// many passes (each pass already retries every chunk a few times).
const MAX_FINISH_ATTEMPTS = 5;
const CHUNK_RETRIES = 2;
const CHUNK_BACKOFF_MS = 500;
// This many chunks in a row failing means the embedding server is down, not
// that one chunk is bad — stop the pass instead of grinding through the rest.
const CONSECUTIVE_FAILURE_LIMIT = 3;
const INSERT_BATCH = 200;
const SELF_CHECK_SAMPLE = 5;
const EXPECTED_DIMS = 1024;

// ── Types ───────────────────────────────────────────────────────────────

export interface UpdatePreview {
  mode: DatasetMode;
  rowsInFile: number;
  added: number;
  updated: number;
  unchanged: number;
  // MERGE: existing Q&As missing from the file, kept as they are.
  carriedOver: number;
  // MERGE: carried-over Q&As that could not keep their old vectors (missing, or
  // made by another embedding model) and are embedded fresh as new rows.
  reembeddedForModel: number;
  // REPLACE: existing Q&As missing from the file, dropped from the new version.
  removed: number;
  removedSamples: { qaId: string; question: string }[];
  chunksToEmbed: number;
  chunksCopied: number;
  chunksReused: number;
  // The workbook has a qa_id column (the export does; hand-made files usually don't).
  fileHasQaIdColumn: boolean;
  // MERGE: added rows that look like edited versions of Q&As being carried over
  // (both would stay live). At most 20 are listed; the count is the total.
  possibleDuplicates: PossibleDuplicate[];
  possibleDuplicateCount: number;
}

export type PrepareResult =
  | { kind: 'DRY_RUN'; preview: UpdatePreview }
  | { kind: 'NOOP'; preview: UpdatePreview }
  | { kind: 'CREATED'; versionId: number; versionNo: number; preview: UpdatePreview };

export class RemovalConfirmationRequired extends AppError {
  constructor(public preview: UpdatePreview) {
    super(
      `REPLACE would remove ${preview.removed} existing Q&A(s) that are not in the uploaded file. ` +
      `Nothing was changed. Re-submit with confirmRemovals=${preview.removed} to proceed.`,
      409
    );
    this.name = 'RemovalConfirmationRequired';
  }
}

export interface PrepareOptions {
  mode?: DatasetMode;
  // Must equal the number of Q&As a REPLACE would remove (shown in the
  // preview) — ties the confirmation to what the admin was actually told.
  confirmRemovals?: number;
  // Plan and report only; write nothing.
  dryRun?: boolean;
  filename?: string;
  // Runs after the plan is validated and right before anything is written
  // (the controller archives the raw file to S3 here, as it always did).
  beforeBuild?: (info: { firstVersion: boolean }) => Promise<void>;
}

export interface FinishDeps {
  embed?: (text: string) => Promise<number[]>;
  // Batched embedder. Defaults to the real server's /embed_batch unless only
  // `embed` is injected, in which case chunks are embedded one by one.
  embedBatch?: (texts: string[]) => Promise<number[][]>;
  embedBatchSize?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  chunkRetries?: number;
  chunkBackoffMs?: number;
  consecutiveFailureLimit?: number;
}

export interface FinishResult {
  outcome: 'ACTIVATED' | 'FAILED' | 'PAUSED' | 'SKIPPED';
  error?: string;
}

interface ActiveChunkRow extends QaFields {
  id: number;
  qa_id: string;
  chunk_index: number;
  chunk_text: string;
  content_hash: string | null;
  embedding_model_version: string | null;
  has_embedding: boolean;
}

interface NewChunkSpec {
  qaId: string;
  chunkIndex: number;
  fields: QaFields;
  chunkText: string;
  contentHash: string;
  copyFromChunkId: number | null;
}

interface Plan {
  lectureId: number;
  mode: DatasetMode;
  activeVersionId: number | null;
  fileHash: string;
  filename: string | null;
  newChunks: NewChunkSpec[];
  reused: { qaId: string; chunkIndex: number; chunkId: number }[];
  carriedQaIds: string[];
  preview: UpdatePreview;
}

// ── Planning ────────────────────────────────────────────────────────────

const loadActiveChunks = async (lectureId: number): Promise<{ versionId: number | null; chunks: ActiveChunkRow[] }> => {
  const { rows: l } = await query<{ active_version_id: number | null }>(
    'SELECT active_version_id FROM lectures WHERE id = $1', [lectureId]
  );
  const versionId = l[0]?.active_version_id ?? null;
  if (versionId === null) return { versionId: null, chunks: [] };
  const { rows } = await query<ActiveChunkRow>(
    `SELECT c.id, d.qa_id, d.chunk_index, c.topic, c.question, c.answer, c.chunk_text,
            c.start_time, c.end_time, c.keywords, c.llm_name, c.content_hash, c.embedding_model_version,
            (c.local_embedding IS NOT NULL) AS has_embedding
     FROM dataset_version_chunks d
     JOIN lecture_qna_chunks c ON c.id = d.chunk_id
     WHERE d.version_id = $1
     ORDER BY c.id`,
    [versionId]
  );
  return { versionId, chunks: rows };
};

const planUpdate = async (
  lectureId: number,
  fileRows: FileRow[],
  mode: DatasetMode,
  fileHash: string,
  filename: string | null,
  fileHasQaIdColumn: boolean
): Promise<Plan> => {
  const { versionId, chunks } = await loadActiveChunks(lectureId);

  const oldByQa = new Map<string, ActiveChunkRow[]>();
  for (const c of chunks) {
    const g = oldByQa.get(c.qa_id);
    if (g) g.push(c); else oldByQa.set(c.qa_id, [c]);
  }
  for (const g of oldByQa.values()) g.sort((a, b) => a.chunk_index - b.chunk_index);
  const activeQas: ActiveQa[] = [...oldByQa.entries()].map(([qaId, pieces]) => ({ qaId, fields: pieces[0] }));

  const { matches, errors } = matchRows(fileRows, activeQas, newQaId);
  if (errors.length > 0) {
    const shown = errors.slice(0, 10).map(e => `  - ${e}`).join('\n');
    const more = errors.length > 10 ? `\n  …and ${errors.length - 10} more` : '';
    throw new AppError(`Dataset not applied — ${errors.length} problem(s) found, nothing was changed:\n${shown}${more}`, 400);
  }

  const newChunks: NewChunkSpec[] = [];
  const reused: Plan['reused'] = [];
  let added = 0, updated = 0, unchanged = 0;
  const addedRows: FileRow[] = [];
  const matchedQaIds = new Set<string>();

  for (let i = 0; i < fileRows.length; i++) {
    const row = fileRows[i];
    const m = matches[i];
    matchedQaIds.add(m.qaId);
    const old = oldByQa.get(m.qaId) ?? [];
    const pieces = await buildChunkPieces({
      topic: row.topic ?? undefined, question: row.question, answer: row.answer, keywords: row.keywords ?? undefined,
    });

    let allReused = true;
    for (const piece of pieces) {
      const o = old.find(x => x.chunk_index === piece.chunkIndex);
      const sameModel = !!o && o.has_embedding && o.embedding_model_version === EMBEDDING_MODEL_VERSION;
      if (o && sameModel && o.chunk_text === piece.chunkText && fieldsEqual(o, row)) {
        reused.push({ qaId: m.qaId, chunkIndex: piece.chunkIndex, chunkId: o.id });
        continue;
      }
      allReused = false;
      const contentHash = sha256(piece.chunkText);
      // Same embedded text under the same model: the stored vector is still
      // exactly right (only metadata such as timestamps changed), so copy it
      // instead of calling the embedding model.
      const canCopy = !!o && sameModel && (o.content_hash ?? sha256(o.chunk_text)) === contentHash;
      newChunks.push({
        qaId: m.qaId, chunkIndex: piece.chunkIndex, fields: row, chunkText: piece.chunkText, contentHash,
        copyFromChunkId: canCopy ? o!.id : null,
      });
    }

    if (m.isNew) { added++; addedRows.push(row); }
    else if (!allReused || old.length !== pieces.length) updated++;
    else unchanged++;
  }

  const missing = activeQas.filter(q => !matchedQaIds.has(q.qaId));
  // MERGE carries missing Q&As over as memberships of their existing chunk rows —
  // but only if every piece still has a vector from the CURRENT model. Otherwise
  // the version would mix models, so all of that Q&A's pieces are embedded fresh
  // as NEW rows (same qa_id / fields / chunk_text); the active version's rows are
  // never touched.
  const carriedQaIds: string[] = [];
  let reembeddedForModel = 0;
  let duplicates: PossibleDuplicate[] = [];
  if (mode === 'MERGE') {
    // Every missing Q&A stays live under MERGE (carried over or re-embedded).
    duplicates = findPossibleDuplicates(addedRows, missing.map(q => ({ qaId: q.qaId, question: q.fields.question, answer: q.fields.answer })));
    for (const q of missing) {
      const pieces = oldByQa.get(q.qaId)!;
      if (pieces.every(c => c.has_embedding && c.embedding_model_version === EMBEDDING_MODEL_VERSION)) {
        carriedQaIds.push(q.qaId);
        continue;
      }
      reembeddedForModel++;
      for (const c of pieces) {
        newChunks.push({
          qaId: q.qaId, chunkIndex: c.chunk_index, fields: c, chunkText: c.chunk_text,
          contentHash: c.content_hash ?? sha256(c.chunk_text), copyFromChunkId: null,
        });
      }
    }
  }
  const removedList = mode === 'REPLACE' ? missing : [];

  const preview: UpdatePreview = {
    mode,
    rowsInFile: fileRows.length,
    added, updated, unchanged,
    carriedOver: carriedQaIds.length,
    reembeddedForModel,
    removed: removedList.length,
    removedSamples: removedList.slice(0, 10).map(q => ({ qaId: q.qaId, question: q.fields.question })),
    chunksToEmbed: newChunks.filter(c => c.copyFromChunkId === null).length,
    chunksCopied: newChunks.filter(c => c.copyFromChunkId !== null).length,
    chunksReused: reused.length,
    fileHasQaIdColumn,
    possibleDuplicates: duplicates.slice(0, 20),
    possibleDuplicateCount: duplicates.length,
  };

  return { lectureId, mode, activeVersionId: versionId, fileHash, filename, newChunks, reused, carriedQaIds, preview };
};

// ── Building a version ──────────────────────────────────────────────────

const buildVersion = async (plan: Plan): Promise<{ versionId: number; versionNo: number }> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: lec } = await client.query<{ active_version_id: number | null }>(
      'SELECT active_version_id FROM lectures WHERE id = $1 FOR UPDATE', [plan.lectureId]
    );
    if (!lec[0]) throw new AppError(`Lecture #${plan.lectureId} not found`, 404);
    if ((lec[0].active_version_id ?? null) !== plan.activeVersionId) {
      throw new AppError('The lecture\'s dataset changed while this upload was being prepared. Nothing was applied — please upload again.', 409);
    }

    const { rows: vn } = await client.query<{ n: number }>(
      'SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM dataset_versions WHERE lecture_id = $1', [plan.lectureId]
    );
    const versionNo = vn[0].n;

    let versionId: number;
    try {
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO dataset_versions
           (lecture_id, version_no, status, mode, source_filename, file_hash, embedding_model_version, chunking_config_version, stats)
         VALUES ($1, $2, 'BUILDING', $3, $4, $5, $6, $7, $8::jsonb)
         RETURNING id`,
        [plan.lectureId, versionNo, plan.mode, plan.filename, plan.fileHash,
         EMBEDDING_MODEL_VERSION, CHUNKING_CONFIG_VERSION, JSON.stringify(plan.preview)]
      );
      versionId = rows[0].id;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError('Another dataset update for this lecture is still in progress. Wait for it to finish, then upload again.', 409);
      }
      throw err;
    }

    // New chunk rows (immutable once written).
    const created = new Map<string, number>(); // `${qaId}#${chunkIndex}` → chunk id
    for (let off = 0; off < plan.newChunks.length; off += INSERT_BATCH) {
      const batch = plan.newChunks.slice(off, off + INSERT_BATCH);
      const { rows } = await client.query<{ id: number; qa_id: string; chunk_index: number }>(
        `INSERT INTO lecture_qna_chunks
           (lecture_id, topic, question, answer, chunk_text, chunk_index, start_time, end_time, keywords, llm_name, qa_id, content_hash)
         SELECT $1, t.topic, t.question, t.answer, t.chunk_text, t.chunk_index, t.start_time, t.end_time, t.keywords, t.llm_name, t.qa_id, t.content_hash
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[])
              AS t(topic, question, answer, chunk_text, chunk_index, start_time, end_time, keywords, llm_name, qa_id, content_hash)
         RETURNING id, qa_id, chunk_index`,
        [
          plan.lectureId,
          batch.map(c => c.fields.topic), batch.map(c => c.fields.question), batch.map(c => c.fields.answer),
          batch.map(c => c.chunkText), batch.map(c => c.chunkIndex),
          batch.map(c => c.fields.start_time), batch.map(c => c.fields.end_time),
          batch.map(c => c.fields.keywords), batch.map(c => c.fields.llm_name),
          batch.map(c => c.qaId), batch.map(c => c.contentHash),
        ]
      );
      for (const r of rows) created.set(`${r.qa_id}#${r.chunk_index}`, r.id);
    }

    // Copy still-valid vectors onto the new rows (no embedding call needed).
    const copies = plan.newChunks
      .filter(c => c.copyFromChunkId !== null)
      .map(c => ({ newId: created.get(`${c.qaId}#${c.chunkIndex}`)!, oldId: c.copyFromChunkId! }));
    if (copies.length > 0) {
      await client.query(
        `UPDATE lecture_qna_chunks n
         SET local_embedding = o.local_embedding, embedding_model_version = o.embedding_model_version
         FROM lecture_qna_chunks o, unnest($1::int[], $2::int[]) AS m(new_id, old_id)
         WHERE n.id = m.new_id AND o.id = m.old_id`,
        [copies.map(c => c.newId), copies.map(c => c.oldId)]
      );
    }

    // Membership: reused chunks + brand-new chunks + (MERGE) carried-over Q&As.
    const members: { chunkId: number; qaId: string; chunkIndex: number }[] = [
      ...plan.reused.map(r => ({ chunkId: r.chunkId, qaId: r.qaId, chunkIndex: r.chunkIndex })),
      ...plan.newChunks.map(c => ({ chunkId: created.get(`${c.qaId}#${c.chunkIndex}`)!, qaId: c.qaId, chunkIndex: c.chunkIndex })),
    ];
    for (let off = 0; off < members.length; off += 1000) {
      const b = members.slice(off, off + 1000);
      await client.query(
        `INSERT INTO dataset_version_chunks (version_id, chunk_id, qa_id, chunk_index)
         SELECT $1, t.chunk_id, t.qa_id, t.chunk_index
         FROM unnest($2::int[], $3::text[], $4::int[]) AS t(chunk_id, qa_id, chunk_index)`,
        [versionId, b.map(m => m.chunkId), b.map(m => m.qaId), b.map(m => m.chunkIndex)]
      );
    }
    if (plan.carriedQaIds.length > 0 && plan.activeVersionId !== null) {
      await client.query(
        `INSERT INTO dataset_version_chunks (version_id, chunk_id, qa_id, chunk_index)
         SELECT $1, chunk_id, qa_id, chunk_index
         FROM dataset_version_chunks
         WHERE version_id = $2 AND qa_id = ANY($3::text[])`,
        [versionId, plan.activeVersionId, plan.carriedQaIds]
      );
    }

    // Progress bar / lecture status. A lecture that already has an active
    // version stays READY and keeps answering from it; only a first-ever
    // dataset shows the processing states.
    const toEmbed = plan.preview.chunksToEmbed;
    await client.query(
      `UPDATE lectures
       SET progress_current = 0, progress_total = $2, updated_at = NOW(),
           status = CASE WHEN active_version_id IS NULL THEN 'EMBEDDING' ELSE status END
       WHERE id = $1`,
      [plan.lectureId, toEmbed]
    );

    await client.query('COMMIT');
    logger.info(
      `[DATASET] 🧱 Lecture #${plan.lectureId}: built version #${versionNo} (id=${versionId}) — ` +
      `${plan.preview.added} added, ${plan.preview.updated} updated, ${plan.preview.unchanged} unchanged, ` +
      `${plan.preview.carriedOver} carried over, ${plan.preview.removed} removed; ` +
      `${plan.preview.chunksToEmbed} chunk(s) to embed, ${plan.preview.chunksCopied} vector(s) copied, ${plan.preview.chunksReused} reused`
    );
    return { versionId, versionNo };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};

export async function prepareDatasetVersion(
  lectureId: number,
  buffer: Buffer,
  opts: PrepareOptions = {}
): Promise<PrepareResult> {
  await getLectureById(lectureId); // 404 if missing
  const mode = opts.mode ?? 'MERGE';
  if (mode !== 'MERGE' && mode !== 'REPLACE') throw new AppError('mode must be MERGE or REPLACE', 400);

  logger.info(`[DATASET] 🚀 Preparing ${mode} update for lecture #${lectureId}`);
  const rawRows = parseExcel(buffer);
  const fileHasQaIdColumn = rawRows.length > 0 && 'qa_id' in rawRows[0];
  const fileRows = toFileRows(rawRows);
  if (fileRows.length === 0) throw new AppError('No valid rows found in the dataset', 400);

  const plan = await planUpdate(lectureId, fileRows, mode, sha256(buffer), opts.filename ?? null, fileHasQaIdColumn);
  const p = plan.preview;

  if (opts.dryRun) return { kind: 'DRY_RUN', preview: p };
  if (p.removed > 0 && opts.confirmRemovals !== p.removed) throw new RemovalConfirmationRequired(p);

  if (p.added === 0 && p.updated === 0 && p.removed === 0 && p.reembeddedForModel === 0) {
    logger.info(`[DATASET] ✅ Lecture #${lectureId}: uploaded file matches the active dataset — nothing to do`);
    return { kind: 'NOOP', preview: p };
  }

  const firstVersion = plan.activeVersionId === null;
  const previousStatus = firstVersion ? (await getLectureById(lectureId)).status : null;
  if (opts.beforeBuild) await opts.beforeBuild({ firstVersion });
  let built: { versionId: number; versionNo: number };
  try {
    built = await buildVersion(plan);
  } catch (err) {
    // beforeBuild may have moved a dataset-less lecture to DATASET_UPLOADED; if
    // the build never started, put the status back instead of leaving it stuck.
    if (previousStatus !== null && previousStatus !== 'DATASET_UPLOADED') {
      await query(
        `UPDATE lectures SET status = $2, updated_at = NOW() WHERE id = $1 AND status = 'DATASET_UPLOADED' AND active_version_id IS NULL`,
        [lectureId, previousStatus]
      ).catch(() => undefined);
    }
    throw err;
  }
  const { versionId, versionNo } = built;
  return { kind: 'CREATED', versionId, versionNo, preview: p };
}

// ── Embedding, validation, publishing ──────────────────────────────────

const runningVersions = new Set<number>();
// One pending retry timer per version — a sweep or a second pause never stacks timers.
const retryTimers = new Set<number>();
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface VersionRow {
  id: number; lecture_id: number; version_no: number; status: string; attempts: number;
  stats: { chunksToEmbed?: number };
}

const pendingChunks = async (versionId: number) => {
  const { rows } = await query<{ id: number; chunk_text: string }>(
    `SELECT c.id, c.chunk_text
     FROM dataset_version_chunks d JOIN lecture_qna_chunks c ON c.id = d.chunk_id
     WHERE d.version_id = $1 AND c.local_embedding IS NULL
     ORDER BY c.id`,
    [versionId]
  );
  return rows;
};

const failVersion = async (v: VersionRow, message: string): Promise<FinishResult> => {
  await query(
    `UPDATE dataset_versions SET status = 'FAILED', last_error = $2, updated_at = NOW() WHERE id = $1`,
    [v.id, message]
  );
  // A lecture with no active version has nothing to fall back on; one that has
  // one is untouched and keeps answering from it.
  const { rows } = await query<{ active_version_id: number | null }>(
    'SELECT active_version_id FROM lectures WHERE id = $1', [v.lecture_id]
  );
  if (rows[0] && rows[0].active_version_id === null) {
    await updateLectureStatus(v.lecture_id, 'FAILED', message);
  } else {
    logger.error(`[DATASET] ❌ Lecture #${v.lecture_id}: update (version id=${v.id}) failed — ${message}. The previous dataset stays live.`);
  }
  await cleanupOldVersions(v.lecture_id).catch(err => logger.warn(`[DATASET] cleanup after failure: ${(err as Error).message}`));
  return { outcome: 'FAILED', error: message };
};

// Checks that must all pass before a version may go live.
export const validateVersion = async (versionId: number): Promise<string[]> => {
  const problems: string[] = [];

  const { rows: cnt } = await query<{ members: string; no_vec: string; bad_dims: string; bad_vec: string; wrong_model: string }>(
    `SELECT COUNT(*) AS members,
            COUNT(*) FILTER (WHERE c.embedding_model_version IS DISTINCT FROM v.embedding_model_version) AS wrong_model,
            COUNT(*) FILTER (WHERE c.local_embedding IS NULL) AS no_vec,
            COUNT(*) FILTER (WHERE c.local_embedding IS NOT NULL AND vector_dims(c.local_embedding) <> ${EXPECTED_DIMS}) AS bad_dims,
            COUNT(*) FILTER (WHERE c.local_embedding IS NOT NULL AND NOT ((c.local_embedding <#> c.local_embedding) < 0)) AS bad_vec
     FROM dataset_version_chunks d JOIN lecture_qna_chunks c ON c.id = d.chunk_id
     JOIN dataset_versions v ON v.id = d.version_id
     WHERE d.version_id = $1`,
    [versionId]
  );
  const c = cnt[0];
  if (Number(c.members) === 0) problems.push('version contains no chunks');
  if (Number(c.no_vec) > 0) problems.push(`${c.no_vec} chunk(s) have no embedding`);
  if (Number(c.wrong_model) > 0) problems.push(`${c.wrong_model} chunk(s) were embedded with a different model than the version's`);
  if (Number(c.bad_dims) > 0) problems.push(`${c.bad_dims} chunk(s) have a vector of the wrong dimension`);
  if (Number(c.bad_vec) > 0) problems.push(`${c.bad_vec} chunk(s) have an empty/invalid vector`);

  // Every Q&A must have its pieces 0..N-1 with none missing.
  const { rows: gaps } = await query<{ qa_id: string }>(
    `SELECT qa_id FROM dataset_version_chunks WHERE version_id = $1
     GROUP BY qa_id HAVING MIN(chunk_index) <> 0 OR MAX(chunk_index) <> COUNT(*) - 1
     LIMIT 5`,
    [versionId]
  );
  if (gaps.length > 0) problems.push(`Q&A piece numbering is incomplete for: ${gaps.map(g => g.qa_id).join(', ')}`);

  // Searchability self-check: a sample of the version's own vectors must find
  // themselves when searched within this version.
  if (problems.length === 0) {
    const { rows: sample } = await query<{ chunk_id: number }>(
      `SELECT chunk_id FROM dataset_version_chunks WHERE version_id = $1 ORDER BY random() LIMIT ${SELF_CHECK_SAMPLE}`,
      [versionId]
    );
    for (const s of sample) {
      const { rows } = await query<{ sim: number }>(
        `SELECT 1 - (c.local_embedding <=> (SELECT local_embedding FROM lecture_qna_chunks WHERE id = $2)) AS sim
         FROM dataset_version_chunks d JOIN lecture_qna_chunks c ON c.id = d.chunk_id
         WHERE d.version_id = $1
         ORDER BY c.local_embedding <=> (SELECT local_embedding FROM lecture_qna_chunks WHERE id = $2)
         LIMIT 1`,
        [versionId, s.chunk_id]
      );
      if (!rows[0] || !(rows[0].sim >= 0.999)) {
        problems.push(`self-retrieval check failed for chunk ${s.chunk_id} (best similarity ${rows[0]?.sim ?? 'n/a'})`);
        break;
      }
    }
  }
  return problems;
};

const activateVersion = async (versionId: number): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: v } = await client.query<{ lecture_id: number; status: string }>(
      'SELECT lecture_id, status FROM dataset_versions WHERE id = $1 FOR UPDATE', [versionId]
    );
    if (!v[0]) throw new AppError(`Dataset version ${versionId} not found`, 404);
    await client.query('SELECT id FROM lectures WHERE id = $1 FOR UPDATE', [v[0].lecture_id]);
    if (v[0].status !== 'READY_TO_ACTIVATE') throw new AppError(`Version ${versionId} is ${v[0].status}, not ready to activate`, 409);

    await client.query(
      `UPDATE dataset_versions SET status = 'SUPERSEDED', updated_at = NOW()
       WHERE lecture_id = $1 AND status = 'ACTIVE'`, [v[0].lecture_id]
    );
    await client.query(
      `UPDATE dataset_versions SET status = 'ACTIVE', activated_at = NOW(), updated_at = NOW(), last_error = NULL WHERE id = $1`,
      [versionId]
    );
    await client.query(
      `UPDATE lectures SET active_version_id = $1, status = 'READY', updated_at = NOW() WHERE id = $2`,
      [versionId, v[0].lecture_id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};

export async function finishDatasetVersion(versionId: number, deps: FinishDeps = {}): Promise<FinishResult> {
  if (runningVersions.has(versionId)) return { outcome: 'SKIPPED' };
  runningVersions.add(versionId);
  try {
    const embed = deps.embed ?? ((t: string) => generateEmbedding(t));
    const embedBatch = deps.embedBatch ?? (deps.embed ? undefined : generateEmbeddingsBatch);
    const batchSizeCfg = Math.min(64, Math.max(1, deps.embedBatchSize ?? env.DATASET.EMBED_BATCH));
    const maxAttempts = deps.maxAttempts ?? MAX_FINISH_ATTEMPTS;
    const retryDelay = deps.retryDelayMs ?? env.DATASET.RETRY_DELAY_MS;
    const chunkRetries = deps.chunkRetries ?? CHUNK_RETRIES;
    const backoff = deps.chunkBackoffMs ?? CHUNK_BACKOFF_MS;
    const failLimit = deps.consecutiveFailureLimit ?? CONSECUTIVE_FAILURE_LIMIT;

    const { rows } = await query<VersionRow>(
      'SELECT id, lecture_id, version_no, status, attempts, stats FROM dataset_versions WHERE id = $1', [versionId]
    );
    const v = rows[0];
    if (!v || (v.status !== 'BUILDING' && v.status !== 'READY_TO_ACTIVATE')) return { outcome: 'SKIPPED' };

    if (v.status === 'BUILDING') {
      const pending = await pendingChunks(versionId);
      const total = v.stats.chunksToEmbed ?? pending.length;
      if (pending.length > 0) {
        logger.info(`[DATASET] 🔁 Lecture #${v.lecture_id} version #${v.version_no}: embedding ${pending.length} pending chunk(s) (${total - pending.length} already done)`);
      }
      await updateLectureProgress(v.lecture_id, Math.max(0, total - pending.length), total);

      let consecutive = 0;
      let done = 0;
      // Failure kinds seen in this pass. An outage is "the embedding service was
      // unreachable and nothing else went wrong" — however few chunks are left.
      let sawUnavailable = false;
      let sawOtherFailure = false;
      type Pending = { id: number; chunk_text: string };
      // One chunk with its own retries; records the failure kind on the pass.
      const embedOne = async (chunk: Pending): Promise<boolean> => {
        let lastErr: unknown;
        for (let t = 0; t <= chunkRetries; t++) {
          try {
            const vec = await embed(chunk.chunk_text);
            await query(
              `UPDATE lecture_qna_chunks SET local_embedding = $1::vector, embedding_model_version = $2
               WHERE id = $3 AND local_embedding IS NULL`,
              [`[${vec.join(',')}]`, EMBEDDING_MODEL_VERSION, chunk.id]
            );
            return true;
          } catch (err) {
            lastErr = err;
            if (t < chunkRetries) await sleep(backoff * (t + 1));
          }
        }
        logger.error(`[DATASET] ❌ Could not embed chunk id=${chunk.id}: ${(lastErr as Error)?.message}`);
        if (lastErr instanceof EmbeddingUnavailableError) sawUnavailable = true; else sawOtherFailure = true;
        return false;
      };

      // A whole batch in one embedder call and ONE UPDATE. Returns true when the
      // batch was written; false on an outage (after retries) — a non-outage
      // failure throws so the caller can retry the batch chunk by chunk.
      const embedBatchOnce = async (batch: Pending[]): Promise<boolean> => {
        let lastErr: unknown;
        for (let t = 0; t <= chunkRetries; t++) {
          try {
            const vecs = await embedBatch!(batch.map(c => c.chunk_text));
            await query(
              `UPDATE lecture_qna_chunks c
               SET local_embedding = u.emb::vector, embedding_model_version = $3
               FROM unnest($1::bigint[], $2::text[]) AS u(id, emb)
               WHERE c.id = u.id AND c.local_embedding IS NULL`,
              [batch.map(c => c.id), vecs.map(v => `[${v.join(',')}]`), EMBEDDING_MODEL_VERSION]
            );
            return true;
          } catch (err) {
            if (!(err instanceof EmbeddingUnavailableError)) throw err;
            lastErr = err;
            if (t < chunkRetries) await sleep(backoff * (t + 1));
          }
        }
        logger.error(`[DATASET] ❌ Embedding service unavailable for a batch of ${batch.length}: ${(lastErr as Error)?.message}`);
        sawUnavailable = true;
        return false;
      };

      const batchSize = embedBatch ? batchSizeCfg : 1;
      for (let i = 0; i < pending.length && consecutive < failLimit; i += batchSize) {
        const batch = pending.slice(i, i + batchSize);
        if (!embedBatch) {
          if (await embedOne(batch[0])) { consecutive = 0; done++; await updateLectureProgress(v.lecture_id, Math.min(total, total - pending.length + done)); }
          else consecutive++;
          continue;
        }
        let okCount = 0;
        try {
          okCount = (await embedBatchOnce(batch)) ? batch.length : 0;
          if (okCount === 0) { consecutive += batch.length; continue; }
        } catch (err) {
          logger.warn(`[DATASET] Batch of ${batch.length} failed (${(err as Error).message}); retrying chunk by chunk`);
          for (const chunk of batch) {
            if (await embedOne(chunk)) { okCount++; consecutive = 0; } else consecutive++;
            if (consecutive >= failLimit) break;
          }
        }
        if (okCount === batch.length) consecutive = 0;
        done += okCount;
        if (okCount > 0) await updateLectureProgress(v.lecture_id, Math.min(total, total - pending.length + done));
      }

      const remaining = (await pendingChunks(versionId)).length;
      const outage = sawUnavailable && !sawOtherFailure;
      if (remaining > 0) {
        let note: string;
        if (outage) {
          // The embedding service is down, which is not the dataset's fault: keep
          // the build alive and keep retrying for as long as it takes. Attempts are
          // NOT consumed, so the version can never be failed by an outage — it
          // finishes by itself once the service is back, no backend restart needed.
          note = `Embedding service unavailable — ${remaining} chunk(s) waiting; retrying automatically every ${Math.round(retryDelay / 1000)}s`;
          await query('UPDATE dataset_versions SET last_error = $2, updated_at = NOW() WHERE id = $1', [versionId, note]);
        } else {
          const attempts = v.attempts + 1;
          note = `${remaining} chunk(s) could not be embedded (attempt ${attempts}/${maxAttempts})`;
          await query('UPDATE dataset_versions SET attempts = $2, last_error = $3, updated_at = NOW() WHERE id = $1', [versionId, attempts, note]);
          if (attempts >= maxAttempts) {
            return failVersion(v, `Embedding did not complete after ${attempts} attempts; ${remaining} chunk(s) have no embedding`);
          }
        }
        logger.warn(`[DATASET] ⏸️  Lecture #${v.lecture_id} version #${v.version_no}: ${note}`);
        if (!retryTimers.has(versionId)) {
          retryTimers.add(versionId);
          const timer = setTimeout(() => {
            retryTimers.delete(versionId);
            void finishDatasetVersion(versionId, deps).catch(e => logger.error('[DATASET] retry failed', e));
          }, retryDelay);
          timer.unref();
        }
        return { outcome: 'PAUSED' };
      }

      // Past the embedding step: any recorded outage note no longer applies.
      await query('UPDATE dataset_versions SET last_error = NULL WHERE id = $1', [versionId]);

      const problems = await validateVersion(versionId);
      if (problems.length > 0) return failVersion(v, `Validation failed: ${problems.join('; ')}`);
      await query(`UPDATE dataset_versions SET status = 'READY_TO_ACTIVATE', updated_at = NOW() WHERE id = $1`, [versionId]);
    }

    // READY_TO_ACTIVATE (also reached after a crash between validation and the switch).
    try {
      await activateVersion(versionId);
    } catch (err) {
      return failVersion(v, `Activation failed: ${(err as Error).message}`);
    }
    logger.info(`[DATASET] 🎉 Lecture #${v.lecture_id}: version #${v.version_no} is now ACTIVE`);
    await cleanupOldVersions(v.lecture_id).catch(err => logger.warn(`[DATASET] cleanup after activation: ${(err as Error).message}`));
    return { outcome: 'ACTIVATED' };
  } finally {
    runningVersions.delete(versionId);
  }
}

// Server start: continue any version that was mid-build when the process
// died. Safe to call repeatedly — finishDatasetVersion only embeds chunks that
// still have no vector, and a version already being worked on is skipped.
export async function resumePendingVersions(deps: FinishDeps = {}): Promise<number[]> {
  const { rows } = await query<{ id: number; lecture_id: number }>(
    `SELECT id, lecture_id FROM dataset_versions WHERE status IN ('BUILDING','READY_TO_ACTIVATE') ORDER BY id`
  );
  for (const r of rows) {
    logger.info(`[DATASET] ♻️  Resuming dataset version id=${r.id} for lecture #${r.lecture_id}`);
    await finishDatasetVersion(r.id, deps).catch(err => logger.error(`[DATASET] resume of version ${r.id} failed`, err));
  }
  return rows.map(r => r.id);
}

// ── Retention ───────────────────────────────────────────────────────────
// Keeps the ACTIVE version plus the most recent previous successful one
// (for rollback). In-flight (BUILDING / READY_TO_ACTIVATE) versions are never
// counted or touched. Failed versions are emptied but their row (and error)
// stays. Chunks that nothing live uses any more are deleted — except chunks
// still referenced by chat history or cached answers, which keep their text
// (so existing chats still show their sources) and only lose their vector.

const purgeVersions = async (versionIds: number[]): Promise<void> => {
  if (versionIds.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cand } = await client.query<{ chunk_id: number }>(
      'SELECT DISTINCT chunk_id FROM dataset_version_chunks WHERE version_id = ANY($1::int[])', [versionIds]
    );
    const ids = cand.map(c => c.chunk_id);
    await client.query('DELETE FROM rag_answer_memory WHERE dataset_version_id = ANY($1::int[])', [versionIds]);
    await client.query('DELETE FROM dataset_version_chunks WHERE version_id = ANY($1::int[])', [versionIds]);
    if (ids.length > 0) {
      await client.query(
        `DELETE FROM lecture_qna_chunks c
         WHERE c.id = ANY($1::int[])
           AND NOT EXISTS (SELECT 1 FROM dataset_version_chunks d WHERE d.chunk_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM chat_history h WHERE c.id = ANY(h.source_chunk_ids))
           AND NOT EXISTS (SELECT 1 FROM rag_answer_memory m WHERE c.id = ANY(m.source_chunk_ids))`,
        [ids]
      );
      await client.query(
        `UPDATE lecture_qna_chunks c SET local_embedding = NULL
         WHERE c.id = ANY($1::int[]) AND c.local_embedding IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM dataset_version_chunks d WHERE d.chunk_id = c.id)`,
        [ids]
      );
    }
    await client.query("UPDATE dataset_versions SET status = CASE WHEN status = 'SUPERSEDED' THEN 'ARCHIVED' ELSE status END, updated_at = NOW() WHERE id = ANY($1::int[])", [versionIds]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};

export async function cleanupOldVersions(lectureId: number): Promise<{ purged: number[] }> {
  const { rows } = await query<{ id: number; status: string }>(
    `SELECT id, status FROM dataset_versions
     WHERE lecture_id = $1 AND status IN ('SUPERSEDED','FAILED')
     ORDER BY updated_at DESC, id DESC`,
    [lectureId]
  );
  let keptOne = false;
  const purge: number[] = [];
  for (const r of rows) {
    if (r.status === 'SUPERSEDED' && !keptOne) { keptOne = true; continue; }
    purge.push(r.id);
  }
  // A FAILED version that is already empty needs no further work.
  const { rows: nonEmpty } = purge.length
    ? await query<{ version_id: number }>('SELECT DISTINCT version_id FROM dataset_version_chunks WHERE version_id = ANY($1::int[])', [purge])
    : { rows: [] as { version_id: number }[] };
  const stillFull = new Set(nonEmpty.map(r => r.version_id));
  const supersededToArchive = rows.filter(r => purge.includes(r.id) && r.status === 'SUPERSEDED').map(r => r.id);
  const toPurge = purge.filter(id => stillFull.has(id) || supersededToArchive.includes(id));
  await purgeVersions(toPurge);
  if (toPurge.length > 0) logger.info(`[DATASET] 🧹 Lecture #${lectureId}: purged old dataset version(s) ${toPurge.join(', ')}`);
  return { purged: toPurge };
}

// ── Rollback ────────────────────────────────────────────────────────────

export async function rollbackDataset(lectureId: number): Promise<{ activeVersionId: number; previousVersionId: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: lec } = await client.query<{ active_version_id: number | null }>(
      'SELECT active_version_id FROM lectures WHERE id = $1 FOR UPDATE', [lectureId]
    );
    if (!lec[0]) throw new AppError(`Lecture #${lectureId} not found`, 404);

    const { rows: inflight } = await client.query(
      `SELECT id FROM dataset_versions WHERE lecture_id = $1 AND status IN ('BUILDING','READY_TO_ACTIVATE')`, [lectureId]
    );
    if (inflight.length > 0) throw new AppError('A dataset update is still in progress for this lecture — wait for it to finish before rolling back.', 409);

    const current = lec[0].active_version_id;
    const { rows: prev } = await client.query<{ id: number }>(
      `SELECT id FROM dataset_versions WHERE lecture_id = $1 AND status = 'SUPERSEDED'
       ORDER BY updated_at DESC, id DESC LIMIT 1`, [lectureId]
    );
    if (!current || !prev[0]) throw new AppError('There is no previous dataset version to roll back to.', 404);
    const target = prev[0].id;

    const { rows: chk } = await client.query<{ members: string; missing: string }>(
      `SELECT COUNT(*) AS members, COUNT(*) FILTER (WHERE c.local_embedding IS NULL) AS missing
       FROM dataset_version_chunks d JOIN lecture_qna_chunks c ON c.id = d.chunk_id WHERE d.version_id = $1`, [target]
    );
    if (Number(chk[0].members) === 0 || Number(chk[0].missing) > 0) {
      throw new AppError('The previous version is incomplete and cannot be restored.', 409);
    }

    // The same checks a new version must pass before going live (model, vectors,
    // numbering, self-retrieval): the previous version may have aged since it was built.
    const problems = await validateVersion(target);
    if (problems.length > 0) {
      throw new AppError(`The previous version cannot be restored: ${problems.join('; ')}`, 409);
    }

    await client.query(`UPDATE dataset_versions SET status = 'SUPERSEDED', updated_at = NOW() WHERE id = $1`, [current]);
    await client.query(`UPDATE dataset_versions SET status = 'ACTIVE', activated_at = NOW(), updated_at = NOW() WHERE id = $1`, [target]);
    await client.query(`UPDATE lectures SET active_version_id = $1, status = 'READY', updated_at = NOW() WHERE id = $2`, [target, lectureId]);
    await client.query('COMMIT');
    logger.info(`[DATASET] ⏪ Lecture #${lectureId}: rolled back from version id=${current} to id=${target}`);
    return { activeVersionId: target, previousVersionId: current };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── Read helpers ────────────────────────────────────────────────────────

export const getActiveDatasetVersionId = async (lectureId: number): Promise<number | null> => {
  const { rows } = await query<{ active_version_id: number | null }>(
    'SELECT active_version_id FROM lectures WHERE id = $1', [lectureId]
  );
  return rows[0]?.active_version_id ?? null;
};

export async function listDatasetVersions(lectureId: number) {
  const { rows } = await query(
    `SELECT v.id, v.version_no, v.status, v.mode, v.source_filename, v.embedding_model_version,
            v.chunking_config_version, v.stats, v.attempts, v.last_error, v.created_at, v.activated_at,
            (v.id = l.active_version_id) AS is_active,
            (SELECT COUNT(*) FROM dataset_version_chunks d WHERE d.version_id = v.id) AS chunk_count,
            (SELECT COUNT(*) FROM dataset_version_chunks d JOIN lecture_qna_chunks c ON c.id = d.chunk_id
              WHERE d.version_id = v.id AND c.local_embedding IS NULL) AS pending_count,
            COALESCE((v.stats->>'chunksToEmbed')::int, 0) AS to_embed
     FROM dataset_versions v JOIN lectures l ON l.id = v.lecture_id
     WHERE v.lecture_id = $1 ORDER BY v.version_no DESC`,
    [lectureId]
  );
  return rows;
}

// Export of the active dataset in the same column layout the importer reads,
// with each Q&A's permanent qa_id, so an edited export can be re-uploaded.
export async function exportActiveDataset(lectureId: number): Promise<Buffer> {
  const versionId = await getActiveDatasetVersionId(lectureId);
  if (versionId === null) throw new AppError('This lecture has no active dataset to export.', 404);
  const { rows } = await query<{
    qa_id: string; topic: string | null; question: string; answer: string;
    start_time: string | null; end_time: string | null; keywords: string | null; llm_name: string | null;
  }>(
    `SELECT d.qa_id, c.topic, c.question, c.answer, c.start_time, c.end_time, c.keywords, c.llm_name
     FROM dataset_version_chunks d JOIN lecture_qna_chunks c ON c.id = d.chunk_id
     WHERE d.version_id = $1 AND d.chunk_index = 0
     ORDER BY c.id`,
    [versionId]
  );
  const header = ['qa_id', 'topic', 'question', 'answer', 'start_time', 'end_time', 'keywords', 'llm_name'];
  const sheet = XLSX.utils.json_to_sheet(rows, { header });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'dataset');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ── Readiness: the one definition of "this lecture can answer from its dataset" ──

export interface LectureReadiness { ready: boolean; reason: string }

interface ReadinessRow {
  id: number;
  active_version_id: number | null;
  total: string;
  missing_embedding: string;
  wrong_model: string;
}

const READINESS_SQL = `
  SELECT l.id, l.active_version_id,
         COUNT(d.chunk_id)                                                      AS total,
         COUNT(d.chunk_id) FILTER (WHERE c.local_embedding IS NULL)             AS missing_embedding,
         COUNT(d.chunk_id) FILTER (WHERE c.local_embedding IS NOT NULL
                                     AND c.embedding_model_version IS DISTINCT FROM $2) AS wrong_model
  FROM lectures l
  LEFT JOIN dataset_version_chunks d ON d.version_id = l.active_version_id
  LEFT JOIN lecture_qna_chunks c ON c.id = d.chunk_id
  WHERE ($1::int IS NULL OR l.id = $1)
  GROUP BY l.id`;

const toReadiness = (r: ReadinessRow): LectureReadiness => {
  if (r.active_version_id === null) return { ready: false, reason: 'NO_ACTIVE_VERSION: lecture has no active dataset version' };
  const total = Number(r.total);
  if (total === 0) return { ready: false, reason: `EMPTY_ACTIVE_VERSION: active version ${r.active_version_id} has no chunks` };
  const missing = Number(r.missing_embedding);
  if (missing > 0) return { ready: false, reason: `MISSING_EMBEDDINGS: ${missing}/${total} chunk(s) of active version ${r.active_version_id} have no embedding` };
  const wrong = Number(r.wrong_model);
  if (wrong > 0) return { ready: false, reason: `STALE_EMBEDDING_MODEL: ${wrong}/${total} chunk(s) of active version ${r.active_version_id} are not ${EMBEDDING_MODEL_VERSION}` };
  return { ready: true, reason: `OK: ${total} chunk(s) embedded with ${EMBEDDING_MODEL_VERSION}` };
};

/** Readiness of every lecture, keyed by lecture id, in a single query. */
export async function getAllLectureReadiness(): Promise<Map<number, LectureReadiness>> {
  const { rows } = await query<ReadinessRow>(READINESS_SQL, [null, EMBEDDING_MODEL_VERSION]);
  return new Map(rows.map(r => [r.id, toReadiness(r)]));
}

/**
 * Ready only if the lecture has an active dataset version AND every chunk in it
 * has a local_embedding produced by the current EMBEDDING_MODEL_VERSION.
 * (lecture.status and the agent profile are separate gates.)
 */
export async function getLectureReadiness(lectureId: number): Promise<LectureReadiness> {
  const { rows } = await query<ReadinessRow>(READINESS_SQL, [lectureId, EMBEDDING_MODEL_VERSION]);
  return rows[0] ? toReadiness(rows[0]) : { ready: false, reason: 'LECTURE_NOT_FOUND' };
}

// ── Legacy repair: embed what the ACTIVE version is missing (no in-flight build) ──

export interface RetryResult {
  exitCode: 0 | 1;
  message: string;
  embedded: number;
  failed: number;
  otherModel: number;
}

/**
 * For a lecture with an active version and no build in flight: embeds only the
 * chunks that are members of the active version and have no vector, recording
 * the model version. Chunks outside the active version (orphans kept for chat
 * history) are never touched, and vectors from a different model are never
 * overwritten (the dataset has to be re-uploaded so the pipeline re-embeds it
 * as a new, validated version). The lecture is never set to EMBEDDING and is
 * set READY only when getLectureReadiness agrees.
 */
export async function retryMissingEmbeddings(
  lectureId: number,
  deps: { embed?: (text: string) => Promise<number[]> } = {}
): Promise<RetryResult> {
  const embed = deps.embed ?? generateEmbedding;
  const result = (exitCode: 0 | 1, message: string, extra: Partial<RetryResult> = {}): RetryResult =>
    ({ exitCode, message, embedded: 0, failed: 0, otherModel: 0, ...extra });

  const { rows: lec } = await query<{ active_version_id: number | null }>(
    'SELECT active_version_id FROM lectures WHERE id = $1', [lectureId]);
  if (!lec[0]) return result(1, `Lecture #${lectureId} not found.`);
  const versionId = lec[0].active_version_id;
  if (versionId === null) {
    return result(1, 'This lecture has no active dataset version — upload its dataset from the admin page.');
  }

  if ((await getLectureReadiness(lectureId)).ready) {
    return result(0, `Nothing to do — lecture #${lectureId} is already ready (every chunk of its active version is embedded with ${EMBEDDING_MODEL_VERSION}).`);
  }

  const { rows: missing } = await query<{ id: number; chunk_text: string }>(
    `SELECT c.id, c.chunk_text
     FROM dataset_version_chunks d JOIN lecture_qna_chunks c ON c.id = d.chunk_id
     WHERE d.version_id = $1 AND c.local_embedding IS NULL
     ORDER BY c.id`, [versionId]);

  let embedded = 0;
  for (let i = 0; i < missing.length; i++) {
    const chunk = missing[i];
    try {
      // isQuery stays false: these are stored passages, not student questions.
      const vec = await embed(chunk.chunk_text);
      await query(
        `UPDATE lecture_qna_chunks SET local_embedding = $1::vector, embedding_model_version = $2
         WHERE id = $3 AND local_embedding IS NULL`,
        [`[${vec.join(',')}]`, EMBEDDING_MODEL_VERSION, chunk.id]);
      embedded++;
      logger.info(`[RETRY] Embedded ${i + 1}/${missing.length} (id=${chunk.id})`);
    } catch (err) {
      logger.error(`[RETRY] ❌ Failed chunk id=${chunk.id}`, err);
    }
  }
  const failed = missing.length - embedded;

  const { rows: other } = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM dataset_version_chunks d JOIN lecture_qna_chunks c ON c.id = d.chunk_id
     WHERE d.version_id = $1 AND c.local_embedding IS NOT NULL AND c.embedding_model_version IS DISTINCT FROM $2`,
    [versionId, EMBEDDING_MODEL_VERSION]);
  const otherModel = Number(other[0].n);

  const ready = (await getLectureReadiness(lectureId)).ready;
  if (ready) await updateLectureStatus(lectureId, 'READY');

  const parts = [`${embedded}/${missing.length} missing chunk(s) of the active version embedded.`];
  if (failed > 0) parts.push(`${failed} chunk(s) still have no embedding — is the embedding server running? Run this again.`);
  if (otherModel > 0) {
    parts.push(`${otherModel} chunk(s) have a vector from a different embedding model and were NOT overwritten — ` +
      `export the dataset and re-upload it (REPLACE) so the pipeline re-embeds it as a new version.`);
  }
  if (ready) parts.push(`Lecture #${lectureId} is ready.`);
  return result(ready ? 0 : 1, parts.join(' '), { embedded, failed, otherModel });
}
