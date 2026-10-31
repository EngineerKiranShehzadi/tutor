/**
 * End-to-end scenarios for the incremental / resumable / safely-published
 * dataset pipeline (dataset-version.service.ts) against a REAL Postgres+pgvector.
 *
 * Embeddings are produced by a deterministic fake embedder (so every call can be
 * counted and failures injected); everything else — SQL, transactions,
 * membership, activation, rollback, retention, answer-memory binding, vector
 * search — is the real code path.
 *
 * SAFETY: refuses to run unless the target database is local and its name
 * contains "test"/"pipe" (shared guard: test-db-guard-lib.ts). It never touches Neon.
 *
 * Usage:
 *   DATABASE_URL=postgresql://postgres:test@localhost:55432/askai_pipe \
 *     ts-node --transpile-only src/scripts/test-dataset-pipeline.ts [--lecture-copy <id>]
 */
import { createHash } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import * as XLSX from 'xlsx';
import { join } from 'path';

import { assertThrowawayDb } from './test-db-guard-lib';

assertThrowawayDb('test-dataset-pipeline');

import pool, { query } from '../config/database';
import { EMBEDDING_MODEL_VERSION, EmbeddingUnavailableError } from '../services/embedding.service';
import { buildChunkPieces, parseExcel } from '../services/chunk.service';
import { matchRows, FileRow, ActiveQa, QaFields } from '../services/dataset-plan';
import {
  prepareDatasetVersion, finishDatasetVersion, resumePendingVersions, rollbackDataset, exportActiveDataset,
  listDatasetVersions, RemovalConfirmationRequired, getLectureReadiness, validateVersion, retryMissingEmbeddings,
  cleanupOldVersions, failDatasetVersion, FinishResult as FinishResultT,
} from '../services/dataset-version.service';
import { searchChunks } from '../services/vector-search.service';
import { lookupAnswerMemory, writeAnswerMemory } from '../services/rag-answer-memory.service';
import { askLectureAgent } from '../services/chat.service';
import { buildRequestLogRow, writeRequestLog } from '../observability/request-log.service';

// ── helpers ─────────────────────────────────────────────────────────────

const DIMS = 1024;
const vecFor = (text: string): number[] => {
  let seed = createHash('sha256').update(text).digest().readUInt32LE(0);
  const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const v = Array.from({ length: DIMS }, () => rnd() - 0.5);
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map(x => x / n);
};

class CountingEmbedder {
  calls: string[] = [];
  failOn: ((text: string) => boolean) | null = null;
  zeroVectors = false;
  gate: Promise<void> | null = null;
  delayMs = 0;
  embed = async (text: string): Promise<number[]> => {
    if (this.gate) await this.gate;
    if (this.delayMs) await new Promise(r => setTimeout(r, this.delayMs));
    this.calls.push(text);
    if (this.failOn?.(text)) throw new Error('injected embedding failure');
    return this.zeroVectors ? new Array(DIMS).fill(0) : vecFor(text);
  };
  reset() { this.calls = []; this.failOn = null; this.zeroVectors = false; this.gate = null; this.delayMs = 0; }
}

interface Row { qa_id?: string; question: string; answer: string; keywords?: string; topic?: string }
const makeXlsx = (rows: Row[]): Buffer => {
  const header = ['qa_id', 'topic', 'question', 'answer', 'keywords'].filter(h => rows.some(r => (r as unknown as Record<string, unknown>)[h] !== undefined));
  const ws = XLSX.utils.json_to_sheet(rows, { header });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'S');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
};

const LONG_ANSWER = Array.from({ length: 140 }, (_, i) => `Sentence ${i} of the long answer explains one more detail.`).join(' ');
const baseRows = (n = 12): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    question: `What does test concept number ${i + 1} mean?`,
    answer: i === 5 ? LONG_ANSWER : `Concept ${i + 1} means something specific and unique: ${'detail '.repeat(10)}${i + 1}.`,
    keywords: `kw${i + 1}`,
  }));

const FAST = { retryDelayMs: 20, chunkBackoffMs: 1, maxAttempts: 3 };
let embedder = new CountingEmbedder();
const fin = (versionId: number, extra = {}) => finishDatasetVersion(versionId, { embed: embedder.embed, ...FAST, ...extra });

const countOne = async (sql: string, params: unknown[] = []): Promise<number> =>
  Number((await query<{ n: string }>(sql, params)).rows[0].n);

const lectureState = async (lectureId: number) =>
  (await query<{ status: string; active_version_id: number | null }>('SELECT status, active_version_id FROM lectures WHERE id = $1', [lectureId])).rows[0];

const versionRows = async (lectureId: number) =>
  (await query<{ id: number; version_no: number; status: string; last_error: string | null }>(
    'SELECT id, version_no, status, last_error FROM dataset_versions WHERE lecture_id = $1 ORDER BY version_no', [lectureId])).rows;

const activeChunks = async (lectureId: number) =>
  (await query<{ id: number; qa_id: string; chunk_index: number; question: string; answer: string; has_vec: boolean }>(
    `SELECT c.id, d.qa_id, d.chunk_index, c.question, c.answer, (c.local_embedding IS NOT NULL) AS has_vec
     FROM lectures l JOIN dataset_version_chunks d ON d.version_id = l.active_version_id
     JOIN lecture_qna_chunks c ON c.id = d.chunk_id
     WHERE l.id = $1 ORDER BY c.id`, [lectureId])).rows;

// What chat can actually see: probe the REAL vector search (active version only)
// with the text of every chunk row that exists for the lecture — in any version —
// and collect what comes back.
const visibleAnswers = async (lectureId: number): Promise<Set<string>> => {
  const texts = (await query<{ chunk_text: string }>('SELECT chunk_text FROM lecture_qna_chunks WHERE lecture_id = $1', [lectureId])).rows;
  const seen = new Set<string>();
  for (const t of texts) for (const hit of await searchChunks(vecFor(t.chunk_text), lectureId, 3)) seen.add(hit.answer);
  return seen;
};

const newLecture = async (tag: string): Promise<number> =>
  (await query<{ id: number }>(
    `INSERT INTO lectures (title, youtube_url, youtube_video_id) VALUES ($1, 'https://youtu.be/xxxxxxxxxxx', 'xxxxxxxxxxx') RETURNING id`,
    [`[pipeline-test] ${tag}`])).rows[0].id;

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`);
};

const expectReject = async (p: Promise<unknown>): Promise<{ rejected: boolean; message: string; err?: unknown }> =>
  p.then(() => ({ rejected: false, message: '' }), e => ({ rejected: true, message: (e as Error).message, err: e }));

// A fresh DB has no users; chat_history / answer memory need a real student_id.
const createStudent = async (): Promise<string> =>
  (await query<{ id: string }>(
    `INSERT INTO users (name, email, password_hash, is_verified, role)
     VALUES ('Pipeline Test Student', $1, 'x', TRUE, 'STUDENT') RETURNING id`,
    [`pipeline-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`],
  )).rows[0].id;

const TSNODE = join(__dirname, '../../node_modules/.bin/ts-node');

// Another process's activation of a version, done by hand (same statements as activateVersion).
const activateManually = async (lectureId: number, versionId: number): Promise<void> => {
  await query(`UPDATE dataset_versions SET status = 'SUPERSEDED' WHERE lecture_id = $1 AND status = 'ACTIVE'`, [lectureId]);
  await query(`UPDATE dataset_versions SET status = 'ACTIVE', activated_at = NOW() WHERE id = $1`, [versionId]);
  await query(`UPDATE lectures SET active_version_id = $1, status = 'READY' WHERE id = $2`, [versionId, lectureId]);
};

// Embeds a BUILDING version's pending chunks directly and marks it READY_TO_ACTIVATE
// (the state left by a crash between validation and the switch).
const embedPendingManually = async (versionId: number): Promise<void> => {
  const { rows } = await query<{ id: number; chunk_text: string }>(
    `SELECT c.id, c.chunk_text FROM dataset_version_chunks d JOIN lecture_qna_chunks c ON c.id = d.chunk_id
     WHERE d.version_id = $1 AND c.local_embedding IS NULL`, [versionId]);
  for (const r of rows) {
    await query(`UPDATE lecture_qna_chunks SET local_embedding = $1::vector, embedding_model_version = $2 WHERE id = $3`,
      [`[${vecFor(r.chunk_text).join(',')}]`, EMBEDDING_MODEL_VERSION, r.id]);
  }
  await query(`UPDATE dataset_versions SET status = 'READY_TO_ACTIVATE' WHERE id = $1`, [versionId]);
};

const runWorker = (args: string[]): Promise<string> => new Promise(resolve => {
  const c = spawn(TSNODE, ['--transpile-only', __filename, '--worker', ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let o = ''; c.stdout.on('data', d => { o += d.toString(); }); c.on('exit', () => resolve(o));
});

// ── worker mode (used by the restart-resume scenario) ───────────────────

const workerMain = async () => {
  const mode = process.argv[3];
  const delay = Number(process.argv[4] ?? 0);
  const emb = new CountingEmbedder();
  emb.delayMs = delay;
  if (mode === 'build') {
    const lectureId = Number(process.argv[5]);
    const file = Buffer.from(process.argv[6], 'base64');
    const prep = await prepareDatasetVersion(lectureId, file, { mode: 'MERGE' });
    console.log('WORKER prepared ' + JSON.stringify(prep.kind === 'CREATED' ? { versionId: prep.versionId } : { kind: prep.kind }));
    if (prep.kind === 'CREATED') await finishDatasetVersion(prep.versionId, { embed: emb.embed, ...FAST });
  } else if (mode === 'switch') {
    // Runs with a DIFFERENT EMBEDDING_PROVIDER than the parent, so its EMBEDDING_MODEL_VERSION
    // differs from the one the lecture was built under. Models the operator's path:
    // export the active dataset, re-upload it with Replace.
    const lectureId = Number(process.argv[5]);
    const studentId = process.argv[6];
    const readyBefore = await getLectureReadiness(lectureId);
    let chat = { threw: false, status: 0, message: '' };
    try {
      await askLectureAgent({ studentId, lectureId, question: 'What does test concept number 1 mean?', sessionId: 0 });
    } catch (e) {
      const err = e as { statusCode?: number; message: string };
      chat = { threw: true, status: err.statusCode ?? 0, message: err.message };
    }
    const prep = await prepareDatasetVersion(lectureId, await exportActiveDataset(lectureId), { mode: 'REPLACE' });
    if (prep.kind === 'CREATED') await finishDatasetVersion(prep.versionId, { embed: emb.embed, ...FAST });
    const readyAfter = await getLectureReadiness(lectureId);
    const models = (await query<{ m: string | null; n: string }>(
      `SELECT c.embedding_model_version AS m, COUNT(*) AS n
       FROM lectures l JOIN dataset_version_chunks d ON d.version_id = l.active_version_id JOIN lecture_qna_chunks c ON c.id = d.chunk_id
       WHERE l.id = $1 GROUP BY 1`, [lectureId])).rows.map(r => `${r.m}:${r.n}`).join(',');
    console.log('WORKER switched ' + JSON.stringify({
      version: EMBEDDING_MODEL_VERSION, readyBefore, chat, prepKind: prep.kind, embedCalls: emb.calls.length, readyAfter, models,
    }));
  } else if (mode === 'finish') {
    const r = await finishDatasetVersion(Number(process.argv[5]), { embed: emb.embed, ...FAST });
    console.log('WORKER finished ' + JSON.stringify(r));
  } else if (mode === 'resume') {
    const ids = await resumePendingVersions({ embed: emb.embed, ...FAST });
    console.log('WORKER resumed ' + JSON.stringify({ versionIds: ids, embedCalls: emb.calls.length, texts: emb.calls }));
  }
  await pool.end();
};

// ── scenarios ───────────────────────────────────────────────────────────

const run = async () => {
  const lecture = await newLecture('main');
  const L = lecture;

  // ─────────────────────────────────────────────────────────────────────
  // 1. First upload of a brand-new lecture
  // ─────────────────────────────────────────────────────────────────────
  {
    embedder.reset();
    const file = makeXlsx(baseRows());
    const expectedChunks = (await Promise.all(baseRows().map(r => buildChunkPieces({ question: r.question, answer: r.answer, keywords: r.keywords })))).flat().length;
    const prep = await prepareDatasetVersion(L, file, { filename: 'v1.xlsx' });
    const midState = await lectureState(L);
    const res = prep.kind === 'CREATED' ? await fin(prep.versionId) : null;
    const st = await lectureState(L);
    const chunks = await activeChunks(L);
    check('1. First upload builds, embeds and publishes version 1',
      prep.kind === 'CREATED' && res?.outcome === 'ACTIVATED' && st.status === 'READY' && st.active_version_id === (prep as { versionId: number }).versionId
        && chunks.length === expectedChunks && chunks.every(c => c.has_vec) && embedder.calls.length === expectedChunks && midState.status === 'EMBEDDING' && midState.active_version_id === null,
      `rows=12 chunks(expected)=${expectedChunks} chunks(active)=${chunks.length} embedCalls=${embedder.calls.length} statusDuringBuild=${midState.status} statusAfter=${st.status} outcome=${res?.outcome}`);
    const longPieces = chunks.filter(c => c.question === baseRows()[5].question).length;
    check('1b. A long answer is split into several pieces under ONE qa_id',
      longPieces > 1 && new Set(chunks.filter(c => c.question === baseRows()[5].question).map(c => c.qa_id)).size === 1,
      `pieces for the long answer=${longPieces}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 2. Same file uploaded again
  // ─────────────────────────────────────────────────────────────────────
  {
    embedder.reset();
    const beforeVersions = (await versionRows(L)).length;
    const beforeChunks = await countOne('SELECT COUNT(*) n FROM lecture_qna_chunks WHERE lecture_id = $1', [L]);
    const prep = await prepareDatasetVersion(L, makeXlsx(baseRows()));
    const afterVersions = (await versionRows(L)).length;
    const afterChunks = await countOne('SELECT COUNT(*) n FROM lecture_qna_chunks WHERE lecture_id = $1', [L]);
    check('2. Re-uploading the identical file is a no-op: no new version, no embeddings, no duplicate rows',
      prep.kind === 'NOOP' && embedder.calls.length === 0 && afterVersions === beforeVersions && afterChunks === beforeChunks && prep.preview.unchanged === 12,
      `result=${prep.kind} unchanged=${prep.preview.unchanged} embedCalls=${embedder.calls.length} versions ${beforeVersions}→${afterVersions} chunkRows ${beforeChunks}→${afterChunks}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 3. Edited Q&A + one new Q&A + rows missing from file (MERGE); old dataset live while building
  // ─────────────────────────────────────────────────────────────────────
  let v1Active = (await lectureState(L)).active_version_id!;
  {
    embedder.reset();
    const before = await activeChunks(L);
    const rows = baseRows().slice(0, 8);                       // 4 existing rows missing from the file
    rows[1] = { ...rows[1], answer: 'EDITED ANSWER about concept two, now different.' };   // same question → update by exact unique match
    rows.push({ question: 'What is a brand new concept?', answer: 'A brand new answer.', keywords: 'new' });
    const prep = await prepareDatasetVersion(L, makeXlsx(rows));
    if (prep.kind !== 'CREATED') { check('3. merge update', false, `unexpected ${prep.kind}`); return; }

    // while the new version is still building, chat must see only the OLD dataset
    let release!: () => void;
    embedder.gate = new Promise<void>(r => { release = r; });
    const finishing = fin(prep.versionId);
    await new Promise(r => setTimeout(r, 150));
    const midActive = (await lectureState(L)).active_version_id;
    const oldHit = await searchChunks(vecFor(before.find(c => c.question === baseRows()[1].question)!.answer ? (await query<{ chunk_text: string }>('SELECT chunk_text FROM lecture_qna_chunks WHERE id = $1', [before.find(c => c.question === baseRows()[1].question)!.id])).rows[0].chunk_text : ''), L, 3);
    const visEarly = await visibleAnswers(L);
    const newTextVisibleEarly = [...visEarly].some(a => a.includes('EDITED ANSWER') || a === 'A brand new answer.');
    release();
    const res = await finishing;
    const after = await activeChunks(L);
    const qaOfEdited = before.find(c => c.question === baseRows()[1].question)!.qa_id;

    check('3a. While the update is still embedding, the old dataset stays live and unchanged',
      midActive === v1Active && oldHit.length > 0 && oldHit[0].answer === baseRows()[1].answer && !newTextVisibleEarly,
      `activeVersionDuringBuild=${midActive} (v1=${v1Active}) topHitAnswerIsOld=${oldHit[0]?.answer === baseRows()[1].answer} newContentVisibleEarly=${newTextVisibleEarly}`);
    check('3b. Merge: only the edited + new Q&A were embedded; missing rows carried over; edited Q&A keeps its qa_id',
      res.outcome === 'ACTIVATED' && embedder.calls.length === 2 && prep.preview.updated === 1 && prep.preview.added === 1
        && prep.preview.carriedOver === 4 && prep.preview.removed === 0 && prep.preview.unchanged === 7
        && after.some(c => c.qa_id === qaOfEdited && c.answer.startsWith('EDITED')) && after.length === before.length + 1,
      `embedCalls=${embedder.calls.length} stats=${JSON.stringify({ updated: prep.preview.updated, added: prep.preview.added, unchanged: prep.preview.unchanged, carried: prep.preview.carriedOver, removed: prep.preview.removed })} chunks ${before.length}→${after.length}`);
    const beforeIds = new Set(before.map(c => c.id));
    const reusedSame = after.filter(c => beforeIds.has(c.id)).length;
    check('3c. Unchanged chunks are the SAME rows (embeddings reused, not recomputed)',
      reusedSame === before.length - 1 /* the edited chunk was replaced */ ,
      `chunk rows shared with previous version=${reusedSame}/${before.length - 1} expected`);
    const newHit = await searchChunks(vecFor((await query<{ chunk_text: string }>('SELECT chunk_text FROM lecture_qna_chunks c JOIN dataset_version_chunks d ON d.chunk_id=c.id JOIN lectures l ON l.active_version_id=d.version_id WHERE l.id=$1 AND c.answer LIKE $2 LIMIT 1', [L, 'EDITED%'])).rows[0].chunk_text), L, 3);
    const dupes = await countOne(`SELECT COUNT(*) n FROM (SELECT d.qa_id, d.chunk_index FROM dataset_version_chunks d JOIN lectures l ON l.active_version_id = d.version_id WHERE l.id = $1 GROUP BY 1,2 HAVING COUNT(*) > 1) t`, [L]);
    const visNow = await visibleAnswers(L);
    const oldAnswerStillSearchable = visNow.has(baseRows()[1].answer);
    check('3d. After publish, search returns the new content, the old edited answer is gone, no duplicates',
      newHit[0]?.answer.startsWith('EDITED') && !oldAnswerStillSearchable && dupes === 0,
      `top hit startsWithEDITED=${newHit[0]?.answer.startsWith('EDITED')} oldAnswerStillInActive=${oldAnswerStillSearchable} duplicateQaPieces=${dupes}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 4. Ambiguous / invalid matches are rejected, never guessed
  // ─────────────────────────────────────────────────────────────────────
  {
    const L2 = await newLecture('ambiguity');
    embedder.reset();
    const dupRows: Row[] = [
      { question: 'Same question?', answer: 'Answer from model A.' },
      { question: 'Same question?', answer: 'Answer from model B.' },
      { question: 'Other question?', answer: 'Other answer.' },
    ];
    const p1 = await prepareDatasetVersion(L2, makeXlsx(dupRows));
    if (p1.kind === 'CREATED') await fin(p1.versionId);
    const verBefore = (await versionRows(L2)).length;

    // 4a. identical re-upload of the duplicate-question dataset still matches (identical content), no error
    const same = await prepareDatasetVersion(L2, makeXlsx(dupRows));
    // 4b. edit one of the two same-question rows without a qa_id → ambiguous
    const edited = [{ ...dupRows[0], answer: 'Answer from model A, edited.' }, dupRows[1], dupRows[2]];
    const amb = await expectReject(prepareDatasetVersion(L2, makeXlsx(edited)));
    const verAfter = (await versionRows(L2)).length;
    check('4a. Duplicate questions with identical content re-match safely (no error, no change)', same.kind === 'NOOP', `result=${same.kind}`);
    check('4b. Ambiguous question match → error, nothing changed (no guessing)',
      amb.rejected && /ambiguous/i.test(amb.message) && verBefore === verAfter,
      `rejected=${amb.rejected} versions ${verBefore}→${verAfter} message="${amb.message.split('\n').slice(0, 2).join(' | ').slice(0, 220)}"`);

    // 4c. unknown qa_id
    const unk = await expectReject(prepareDatasetVersion(L2, makeXlsx([{ qa_id: 'qa_doesnotexist', question: 'q', answer: 'a' }])));
    check('4c. Unknown qa_id → error', unk.rejected && /does not exist/i.test(unk.message), `message="${unk.message.split('\n')[1]?.trim()}"`);

    // 4d. using qa_id resolves the ambiguity and edits exactly that Q&A
    const exported = await exportActiveDataset(L2);
    const wb = XLSX.read(exported, { type: 'buffer' });
    const exRows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets[wb.SheetNames[0]]);
    const target = exRows.find(r => r.answer === 'Answer from model A.')!;
    embedder.reset();
    const viaId = await prepareDatasetVersion(L2, makeXlsx(exRows.map(r => r === target ? { ...r, answer: 'Answer from model A, edited.' } : r) as unknown as Row[]));
    if (viaId.kind === 'CREATED') await fin(viaId.versionId);
    const after = await activeChunks(L2);
    check('4d. With qa_id the same edit is applied to exactly that Q&A; the sibling is untouched',
      viaId.kind === 'CREATED' && viaId.preview.updated === 1 && viaId.preview.unchanged === 2 && embedder.calls.length === 1
        && after.find(c => c.qa_id === target.qa_id)?.answer === 'Answer from model A, edited.' && after.some(c => c.answer === 'Answer from model B.'),
      `updated=${viaId.kind === 'CREATED' ? viaId.preview.updated : '-'} embedCalls=${embedder.calls.length}`);

    // 4e. editing the QUESTION text needs the qa_id: with it → update in place; without → new Q&A (old one carried)
    const exported2 = await exportActiveDataset(L2);
    const ex2 = XLSX.utils.sheet_to_json<Record<string, string>>(XLSX.read(exported2, { type: 'buffer' }).Sheets['dataset']);
    const other = ex2.find(r => r.question === 'Other question?')!;
    embedder.reset();
    const q1 = await prepareDatasetVersion(L2, makeXlsx(ex2.map(r => r === other ? { ...r, question: 'Other question, reworded?' } : r) as unknown as Row[]));
    if (q1.kind === 'CREATED') await fin(q1.versionId);
    const a2 = await activeChunks(L2);
    check('4e. Question text edited WITH qa_id → updated in place (same qa_id, old wording gone)',
      q1.kind === 'CREATED' && q1.preview.updated === 1 && q1.preview.added === 0
        && a2.some(c => c.qa_id === other.qa_id && c.question === 'Other question, reworded?') && !a2.some(c => c.question === 'Other question?'),
      `updated=${q1.kind === 'CREATED' ? q1.preview.updated : '-'} added=${q1.kind === 'CREATED' ? q1.preview.added : '-'}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 5. REPLACE needs explicit, count-bound confirmation
  // ─────────────────────────────────────────────────────────────────────
  let vBeforeReplace = 0;
  {
    embedder.reset();
    vBeforeReplace = (await lectureState(L)).active_version_id!;
    const currentCount = (await activeChunks(L)).length;
    const keep = baseRows().slice(0, 8);
    keep[1] = { ...keep[1], answer: 'EDITED ANSWER about concept two, now different.' };
    keep.push({ question: 'What is a brand new concept?', answer: 'A brand new answer.', keywords: 'new' });
    const versionsBefore = (await versionRows(L)).length;
    const noConfirm = await expectReject(prepareDatasetVersion(L, makeXlsx(keep), { mode: 'REPLACE' }));
    const wrongConfirm = await expectReject(prepareDatasetVersion(L, makeXlsx(keep), { mode: 'REPLACE', confirmRemovals: 1 }));
    const dry = await prepareDatasetVersion(L, makeXlsx(keep), { mode: 'REPLACE', dryRun: true });
    const versionsAfter = (await versionRows(L)).length;
    const removed = noConfirm.err instanceof RemovalConfirmationRequired ? noConfirm.err.preview.removed : -1;
    check('5a. REPLACE without confirmation is refused, the message says how many Q&As would be removed, nothing changes',
      noConfirm.rejected && removed === 4 && wrongConfirm.rejected && versionsBefore === versionsAfter && dry.kind === 'DRY_RUN' && dry.preview.removed === 4
        && (await activeChunks(L)).length === currentCount && /remove 4/.test(noConfirm.message),
      `wouldRemove=${removed} wrongCount(1)Rejected=${wrongConfirm.rejected} dryRunRemoved=${dry.kind === 'DRY_RUN' ? dry.preview.removed : '-'} versions ${versionsBefore}→${versionsAfter} msg="${noConfirm.message.slice(0, 90)}…"`);

    const ok = await prepareDatasetVersion(L, makeXlsx(keep), { mode: 'REPLACE', confirmRemovals: 4 });
    if (ok.kind === 'CREATED') await fin(ok.versionId);
    const after = await activeChunks(L);
    const qas = new Set(after.map(c => c.qa_id)).size;
    check('5b. Confirmed REPLACE drops exactly the missing Q&As; previous version is kept for rollback',
      ok.kind === 'CREATED' && qas === 9 && ok.preview.removed === 4 && (await versionRows(L)).some(v => v.id === vBeforeReplace && v.status === 'SUPERSEDED'),
      `qaCount=${qas} (expected 9) statuses=${(await versionRows(L)).map(v => `v${v.version_no}:${v.status}`).join(' ')}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 6. Failed updates: old dataset keeps serving
  // ─────────────────────────────────────────────────────────────────────
  {
    embedder.reset();
    const activeBefore = (await lectureState(L)).active_version_id!;
    const chunksBefore = await activeChunks(L);
    const rows = baseRows().slice(0, 8);
    rows[1] = { ...rows[1], answer: 'EDITED ANSWER about concept two, now different.' };
    rows.push({ question: 'What is a brand new concept?', answer: 'A brand new answer.', keywords: 'new' });
    rows.push({ question: 'Poison question?', answer: 'This one can never be embedded.' });
    const prep = await prepareDatasetVersion(L, makeXlsx(rows), { mode: 'REPLACE', confirmRemovals: 0 });
    embedder.failOn = t => t.includes('never be embedded');
    let outcome = '';
    if (prep.kind === 'CREATED') {
      for (let i = 0; i < 6 && outcome !== 'FAILED'; i++) { outcome = (await fin(prep.versionId)).outcome; if (outcome === 'PAUSED') await new Promise(r => setTimeout(r, 40)); }
    }
    const st = await lectureState(L);
    const vers = await versionRows(L);
    const failedV = vers.find(v => prep.kind === 'CREATED' && v.id === prep.versionId);
    const servedStillSet = await visibleAnswers(L);
    const servedStill = [...servedStillSet];
    check('6a. Embedding keeps failing → version marked FAILED after retries; lecture stays READY on the previous dataset',
      outcome === 'FAILED' && failedV?.status === 'FAILED' && st.status === 'READY' && st.active_version_id === activeBefore,
      `finalOutcome=${outcome} versionStatus=${failedV?.status} lectureStatus=${st.status} activeUnchanged=${st.active_version_id === activeBefore} error="${failedV?.last_error?.slice(0, 80)}"`);
    check('6b. Chat search during/after the failed update still returns the old dataset, with none of the new rows',
      servedStill.length === new Set(chunksBefore.map(c => c.answer)).size
        && !servedStill.some(a => a.includes('never be embedded')) && servedStill.includes(baseRows()[0].answer),
      `distinct answers visible to chat=${servedStill.length} (active dataset has ${new Set(chunksBefore.map(c => c.answer)).size}) poisonRowVisible=${servedStill.some(a => a.includes('never be embedded'))}`);
    const leftovers = await countOne(`SELECT COUNT(*) n FROM dataset_version_chunks WHERE version_id = $1`, [prep.kind === 'CREATED' ? prep.versionId : 0]);
    check('6c. A failed version is emptied (no half-built rows left behind), its error is kept', leftovers === 0 && !!failedV?.last_error, `membershipRowsLeft=${leftovers}`);

    // validation failure: all-zero vectors
    embedder.reset();
    embedder.zeroVectors = true;
    const prep2 = await prepareDatasetVersion(L, makeXlsx([...rows.slice(0, 9), { question: 'Zero-vector question?', answer: 'This row is embedded as an all-zero vector.' }]), { mode: 'REPLACE', confirmRemovals: 0 });
    const r2 = prep2.kind === 'CREATED' ? await fin(prep2.versionId) : null;
    const st2 = await lectureState(L);
    check('6d. Validation catches empty/zero vectors → FAILED, nothing published',
      r2?.outcome === 'FAILED' && /invalid vector|empty/i.test(r2.error ?? '') && st2.active_version_id === activeBefore,
      `outcome=${r2?.outcome} error="${r2?.error?.slice(0, 100)}" activeUnchanged=${st2.active_version_id === activeBefore}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 7. Restart-resume with a REAL killed process
  // ─────────────────────────────────────────────────────────────────────
  {
    const L3 = await newLecture('restart');
    embedder.reset();
    const big = Array.from({ length: 30 }, (_, i): Row => ({ question: `Resume question ${i + 1}?`, answer: `Resume answer ${i + 1} ${'x'.repeat(40)}` }));
    const b64 = makeXlsx(big).toString('base64');
    const child = spawn(TSNODE, ['--transpile-only', __filename, '--worker', 'build', '120', String(L3), b64], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let childOut = '';
    child.stdout.on('data', d => { childOut += d.toString(); });
    // wait until some (but not all) chunks have been embedded, then SIGKILL (a crash, not a clean stop)
    let embeddedAtKill = 0;
    for (let i = 0; i < 400; i++) {
      await new Promise(r => setTimeout(r, 100));
      embeddedAtKill = await countOne(`SELECT COUNT(*) n FROM lecture_qna_chunks WHERE lecture_id = $1 AND local_embedding IS NOT NULL`, [L3]);
      if (embeddedAtKill >= 8) break;
    }
    child.kill('SIGKILL');
    await new Promise(r => child.on('exit', r));
    const total = await countOne(`SELECT COUNT(*) n FROM lecture_qna_chunks WHERE lecture_id = $1`, [L3]);
    const embeddedAfterKill = await countOne(`SELECT COUNT(*) n FROM lecture_qna_chunks WHERE lecture_id = $1 AND local_embedding IS NOT NULL`, [L3]);
    const stAfterKill = await lectureState(L3);
    const vAfterKill = await versionRows(L3);
    check('7a. After a hard kill mid-embedding, progress is in the DB (partial), version still BUILDING, nothing activated',
      embeddedAfterKill > 0 && embeddedAfterKill < total && vAfterKill.length === 1 && vAfterKill[0].status === 'BUILDING' && stAfterKill.active_version_id === null,
      `embedded=${embeddedAfterKill}/${total} versionStatus=${vAfterKill[0]?.status} lectureStatus=${stAfterKill.status}`);

    // "restart": a fresh process resumes
    const resumed = await new Promise<string>((resolve) => {
      const c2 = spawn(TSNODE, ['--transpile-only', __filename, '--worker', 'resume', '0'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let o = ''; c2.stdout.on('data', d => { o += d.toString(); }); c2.on('exit', () => resolve(o));
    });
    const line = resumed.split('\n').find(l => l.startsWith('WORKER resumed '))!;
    const info = JSON.parse(line.slice('WORKER resumed '.length)) as { versionIds: number[]; embedCalls: number; texts: string[] };
    const embeddedFinal = await countOne(`SELECT COUNT(*) n FROM lecture_qna_chunks WHERE lecture_id = $1 AND local_embedding IS NOT NULL`, [L3]);
    const dupRows = await countOne(`SELECT COUNT(*) n FROM (SELECT qa_id, chunk_index FROM dataset_version_chunks d JOIN dataset_versions v ON v.id = d.version_id WHERE v.lecture_id = $1 GROUP BY 1,2 HAVING COUNT(*) > 1) t`, [L3]);
    const totalRows = await countOne(`SELECT COUNT(*) n FROM lecture_qna_chunks WHERE lecture_id = $1`, [L3]);
    const st3 = await lectureState(L3);
    check('7b. After restart the build resumes from the pending chunks only (finished chunks are not embedded again)',
      info.embedCalls === total - embeddedAfterKill && embeddedFinal === total && st3.status === 'READY' && st3.active_version_id !== null,
      `pendingBeforeResume=${total - embeddedAfterKill} embedCallsAfterRestart=${info.embedCalls} embeddedNow=${embeddedFinal}/${total} lectureStatus=${st3.status}`);
    check('7c. Resume created no duplicate rows', dupRows === 0 && totalRows === total, `duplicateQaPieces=${dupRows} chunkRows ${total}→${totalRows}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 8. Rollback, and answer memory bound to the version
  // ─────────────────────────────────────────────────────────────────────
  {
    const student = await createStudent();
    const verList = await versionRows(L);
    const activeNow = (await lectureState(L)).active_version_id!;
    const prevId = verList.filter(v => v.status === 'SUPERSEDED').sort((a, b) => b.version_no - a.version_no)[0]?.id;

    // memory entry under the CURRENT version
    const chunks = await activeChunks(L);
    const hist = (await query<{ id: number }>(`INSERT INTO chat_history (student_id, lecture_id, question, answer, source_chunk_ids) VALUES ($1,$2,'mem q','mem a',$3) RETURNING id`, [student, L, [chunks[0].id]])).rows[0].id;
    const Q = 'What does test concept number 1 mean exactly?';
    const emb = async () => vecFor('mem');
    await writeAnswerMemory({ studentId: student, lectureId: L, sourceChatHistoryId: hist, originalQuestion: Q, retrievalQuery: Q, answer: 'CACHED-UNDER-CURRENT', sourceChunkIds: [chunks[0].id], questionEmbedding: vecFor('mem'), datasetVersionId: activeNow });
    const hit1 = await lookupAnswerMemory({ studentId: student, lectureId: L, question: Q, generateEmbedding: emb });

    // stale-source guard: a chunk that is not in the version must not be filed under it
    await writeAnswerMemory({ studentId: student, lectureId: L, sourceChatHistoryId: hist, originalQuestion: 'other q?', retrievalQuery: 'other q?', answer: 'BAD', sourceChunkIds: [999999999], questionEmbedding: vecFor('b'), datasetVersionId: activeNow });
    const badRow = await countOne(`SELECT COUNT(*) n FROM rag_answer_memory WHERE answer = 'BAD'`);

    const rb = await rollbackDataset(L);
    const afterRb = await lectureState(L);
    const memAfterRollback = await lookupAnswerMemory({ studentId: student, lectureId: L, question: Q, generateEmbedding: emb });
    const searchRb = await visibleAnswers(L);
    const hasRemovedQaBack = searchRb.has(baseRows()[7].answer);   // row 8 existed before the REPLACE
    check('8a. Rollback re-activates the previous version atomically; chat now reads it', rb.activeVersionId === prevId && afterRb.active_version_id === prevId && afterRb.status === 'READY' && hasRemovedQaBack,
      `active ${activeNow}→${afterRb.active_version_id} (expected previous=${prevId}) removedRowSearchableAgain=${hasRemovedQaBack}`);
    check('8b. Cached answer from the newer version is NOT served after rollback (memory is version-bound)',
      hit1.hit?.answer === 'CACHED-UNDER-CURRENT' && memAfterRollback.hit === null && badRow === 0,
      `hitBeforeRollback=${hit1.hit?.answer} hitAfterRollback=${memAfterRollback.hit?.answer ?? 'none'} writeWithForeignChunkStored=${badRow}`);

    const rb2 = await rollbackDataset(L);   // roll forward again (the demoted version is now the "previous")
    const memBack = await lookupAnswerMemory({ studentId: student, lectureId: L, question: Q, generateEmbedding: emb });
    check('8c. Rolling forward again makes that version\'s cache valid again; cached answer is served',
      rb2.activeVersionId === activeNow && memBack.hit?.answer === 'CACHED-UNDER-CURRENT', `active=${rb2.activeVersionId} (expected ${activeNow}) hit=${memBack.hit?.answer ?? 'none'}`);

    // publishing a NEW version invalidates the cache too
    embedder.reset();
    const rows = baseRows().slice(0, 8);
    rows[0] = { ...rows[0], answer: 'Concept 1 has been CORRECTED.' };
    const prep = await prepareDatasetVersion(L, makeXlsx(rows));
    if (prep.kind === 'CREATED') await fin(prep.versionId);
    const memAfterPublish = await lookupAnswerMemory({ studentId: student, lectureId: L, question: Q, generateEmbedding: emb });
    check('8d. Publishing corrected data → the old cached answer is no longer returned', memAfterPublish.hit === null, `hit=${memAfterPublish.hit?.answer ?? 'none'}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 9. Retention: active + 1 previous only; chat source references survive
  // ─────────────────────────────────────────────────────────────────────
  {
    const student = await createStudent();
    // reference one chunk of the CURRENT active version from chat history, then push 2 more versions
    const cur = await activeChunks(L);
    const referenced = cur.find(c => c.answer.startsWith('Concept 1 has been CORRECTED'))!;
    const hist = (await query<{ id: number }>(`INSERT INTO chat_history (student_id, lecture_id, question, answer, source_chunk_ids) VALUES ($1,$2,'ref q','ref a',$3) RETURNING id`, [student, L, [referenced.id]])).rows[0].id;
    for (const n of [1, 2]) {
      const rows = baseRows().slice(0, 8);
      rows[0] = { ...rows[0], answer: `Concept 1 revision ${n}.` };
      embedder.reset();
      const prep = await prepareDatasetVersion(L, makeXlsx(rows));
      if (prep.kind === 'CREATED') await fin(prep.versionId);
    }
    const vers = await versionRows(L);
    const live = vers.filter(v => v.status === 'ACTIVE' || v.status === 'SUPERSEDED');
    const refRow = (await query<{ chunk_text: string; has_vec: boolean }>('SELECT chunk_text, (local_embedding IS NOT NULL) AS has_vec FROM lecture_qna_chunks WHERE id = $1', [referenced.id])).rows[0];
    const src = (await query<{ sources: { id: number; question: string }[] }>(
      `SELECT COALESCE((SELECT json_agg(json_build_object('id', c.id, 'question', c.question)) FROM lecture_qna_chunks c WHERE c.id = ANY(ch.source_chunk_ids)), '[]'::json) AS sources FROM chat_history ch WHERE ch.id = $1`, [hist])).rows[0].sources;
    const inflight = vers.filter(v => v.status === 'BUILDING' || v.status === 'READY_TO_ACTIVATE').length;
    check('9a. Retention keeps exactly ACTIVE + 1 previous successful version; older ones are archived',
      live.length === 2 && live.filter(v => v.status === 'ACTIVE').length === 1 && vers.some(v => v.status === 'ARCHIVED') && inflight === 0,
      `versions=${vers.map(v => `v${v.version_no}:${v.status}`).join(' ')}`);
    check('9b. A chunk referenced by existing chat history survives cleanup (text kept, vector dropped) so the chat\'s sources still resolve',
      !!refRow && src.length === 1 && src[0].id === referenced.id && refRow.has_vec === false,
      `chunkStillExists=${!!refRow} sourcesResolved=${src.length} vectorDropped=${refRow && refRow.has_vec === false}`);
    const orphanUnref = await countOne(
      `SELECT COUNT(*) n FROM lecture_qna_chunks c WHERE c.lecture_id = $1 AND NOT EXISTS (SELECT 1 FROM dataset_version_chunks d WHERE d.chunk_id = c.id)
         AND NOT EXISTS (SELECT 1 FROM chat_history h WHERE c.id = ANY(h.source_chunk_ids)) AND NOT EXISTS (SELECT 1 FROM rag_answer_memory m WHERE c.id = ANY(m.source_chunk_ids))`, [L]);
    check('9c. Chunks used by no version and no chat/cached answer are deleted (no garbage accumulates)', orphanUnref === 0, `unreferenced orphan chunks=${orphanUnref}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 10. Different model / settings → everything re-embedded; same model → reused
  // ─────────────────────────────────────────────────────────────────────
  {
    const L4 = await newLecture('model-change');
    embedder.reset();
    const p = await prepareDatasetVersion(L4, makeXlsx(baseRows(6)));
    if (p.kind === 'CREATED') await fin(p.versionId);
    // pretend the vectors were produced by an older model
    await query(`UPDATE lecture_qna_chunks SET embedding_model_version = 'old-model:768' WHERE lecture_id = $1`, [L4]);
    embedder.reset();
    const p2 = await prepareDatasetVersion(L4, makeXlsx(baseRows(6)));
    if (p2.kind === 'CREATED') await fin(p2.versionId);
    const total = (await activeChunks(L4)).length;
    check('10. Vectors made by a different embedding model are NOT reused: same file re-embeds every chunk (and only then)',
      p2.kind === 'CREATED' && embedder.calls.length === total && p2.preview.updated === 6,
      `result=${p2.kind} embedCalls=${embedder.calls.length}/${total} (model ${EMBEDDING_MODEL_VERSION})`);
    embedder.reset();
    const p3 = await prepareDatasetVersion(L4, makeXlsx(baseRows(6)));
    check('10b. Once on the current model, the same file is a no-op again', p3.kind === 'NOOP' && embedder.calls.length === 0, `result=${p3.kind} embedCalls=${embedder.calls.length}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 11. Only one update in flight per lecture
  // ─────────────────────────────────────────────────────────────────────
  {
    const L5 = await newLecture('concurrent');
    const p = await prepareDatasetVersion(L5, makeXlsx(baseRows(4)));     // left BUILDING on purpose
    const second = await expectReject(prepareDatasetVersion(L5, makeXlsx(baseRows(5))));
    check('11. A second upload while one is still building is refused (409), no second version created',
      p.kind === 'CREATED' && second.rejected && /in progress/i.test(second.message) && (await versionRows(L5)).length === 1, `message="${second.message.slice(0, 100)}"`);
    if (p.kind === 'CREATED') await fin(p.versionId);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 12. Backfilled real lecture (copy of live data): export → re-upload is a no-op
  // ─────────────────────────────────────────────────────────────────────
  {
    const copyArg = process.argv.indexOf('--lecture-copy');
    if (copyArg > -1) {
      const RL = Number(process.argv[copyArg + 1]);
      embedder.reset();
      const exported = await exportActiveDataset(RL);
      const beforeV = (await versionRows(RL)).length;
      const prep = await prepareDatasetVersion(RL, exported);
      // edit one row via the exported qa_id
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(XLSX.read(exported, { type: 'buffer' }).Sheets['dataset']);
      rows[10] = { ...rows[10], answer: rows[10].answer + ' (corrected)' };
      embedder.reset();
      const prep2 = await prepareDatasetVersion(RL, makeXlsx(rows as unknown as Row[]));
      if (prep2.kind === 'CREATED') await fin(prep2.versionId);
      check(`12. Backfilled real lecture #${RL} (${rows.length} Q&As): exported file re-uploads as a no-op; one edit → exactly 1 chunk embedded`,
        prep.kind === 'NOOP' && (await versionRows(RL)).length === beforeV + 1 && prep2.kind === 'CREATED' && embedder.calls.length === 1 && prep2.preview.unchanged === rows.length - 1,
        `reupload=${prep.kind} (unchanged=${prep.preview.unchanged}/${rows.length}) afterEdit: updated=${prep2.kind === 'CREATED' ? prep2.preview.updated : '-'} embedCalls=${embedder.calls.length}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // 14. Embedding service outage: no restart needed, version is never failed by an outage
  // ─────────────────────────────────────────────────────────────────────
  {
    const L6 = await newLecture('outage');
    embedder.reset();
    const p = await prepareDatasetVersion(L6, makeXlsx(baseRows(8)));
    let outageCalls = 0;
    let serviceBack = false;
    const flaky = async (text: string): Promise<number[]> => {
      if (!serviceBack) { outageCalls++; throw new EmbeddingUnavailableError('Local embedding server not reachable (simulated outage)'); }
      return vecFor(text);
    };
    // maxAttempts=2 on purpose: a non-outage failure would give up after 2 passes. An outage must not.
    const first = p.kind === 'CREATED' ? await finishDatasetVersion(p.versionId, { embed: flaky, retryDelayMs: 40, chunkBackoffMs: 1, maxAttempts: 2 }) : null;
    await new Promise(r => setTimeout(r, 400));                       // several retry cycles while the service is down
    const during = (await versionRows(L6))[0];
    const attemptsDuring = (await query<{ attempts: number }>('SELECT attempts FROM dataset_versions WHERE lecture_id = $1', [L6])).rows[0].attempts;
    serviceBack = true;                                              // service comes back — nobody restarts anything
    let statusAfter = '';
    for (let i = 0; i < 50; i++) { await new Promise(r => setTimeout(r, 100)); statusAfter = (await versionRows(L6))[0].status; if (statusAfter === 'ACTIVE') break; }
    const done = await activeChunks(L6);
    check('14. Embedding service down for several retry cycles → version stays BUILDING (never FAILED, attempts not consumed); when it returns, the build finishes by itself, no restart',
      first?.outcome === 'PAUSED' && during.status === 'BUILDING' && attemptsDuring === 0 && /unavailable/i.test(during.last_error ?? '') && outageCalls >= 6
        && statusAfter === 'ACTIVE' && done.length > 0 && done.every(c => c.has_vec) && (await lectureState(L6)).status === 'READY',
      `firstOutcome=${first?.outcome} statusDuringOutage=${during.status} attempts=${attemptsDuring} failedEmbedCallsDuringOutage=${outageCalls} note="${(during.last_error ?? '').slice(0, 60)}" → afterRecovery=${statusAfter} chunks=${done.length}`);
  }

  // 14b: the same, with a single chunk left (fewer than the consecutive-failure limit)
  {
    const L6b = await newLecture('outage-single-chunk');
    const p = await prepareDatasetVersion(L6b, makeXlsx(baseRows(1)));
    let back = false;
    const flaky = async (text: string): Promise<number[]> => { if (!back) throw new EmbeddingUnavailableError('simulated outage'); return vecFor(text); };
    if (p.kind === 'CREATED') await finishDatasetVersion(p.versionId, { embed: flaky, retryDelayMs: 40, chunkBackoffMs: 1, maxAttempts: 2 });
    await new Promise(r => setTimeout(r, 500));
    const v = (await query<{ status: string; attempts: number; last_error: string | null }>('SELECT status, attempts, last_error FROM dataset_versions WHERE lecture_id = $1', [L6b])).rows[0];
    back = true;
    let st = '';
    for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 100)); st = (await versionRows(L6b))[0].status; if (st === 'ACTIVE') break; }
    check('14b. Outage with only ONE chunk left is still treated as an outage (not a chunk failure): never FAILED, attempts not consumed, finishes on recovery',
      v.status === 'BUILDING' && v.attempts === 0 && /unavailable/i.test(v.last_error ?? '') && st === 'ACTIVE', `duringOutage: status=${v.status} attempts=${v.attempts} note="${(v.last_error ?? '').slice(0, 50)}" → afterRecovery=${st}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 14c. P6 batch embedding
  // ─────────────────────────────────────────────────────────────────────
  {
    const vecsByText = async (lectureId: number) => new Map((await query<{ t: string; v: string }>(
      'SELECT chunk_text AS t, local_embedding::text AS v FROM lecture_qna_chunks WHERE lecture_id = $1 AND local_embedding IS NOT NULL', [lectureId])).rows.map(r => [r.t, r.v]));
    const progressOf = async (lectureId: number) => (await query<{ c: number; t: number }>('SELECT progress_current AS c, progress_total AS t FROM lectures WHERE id = $1', [lectureId])).rows[0];
    const batchCalls: number[] = [];
    const goodBatch = async (texts: string[]) => { batchCalls.push(texts.length); return texts.map(vecFor); };

    // (a) same vectors as per-chunk, in ceil(n/size) batch calls
    const La = await newLecture('batch-per-chunk');
    const Lb = await newLecture('batch-batched');
    const rowsB = baseRows(10);
    const pa = await prepareDatasetVersion(La, makeXlsx(rowsB));
    const pb = await prepareDatasetVersion(Lb, makeXlsx(rowsB));
    embedder.reset();
    if (pa.kind === 'CREATED') await finishDatasetVersion(pa.versionId, { embed: embedder.embed, ...FAST });
    if (pb.kind === 'CREATED') await finishDatasetVersion(pb.versionId, { embedBatch: goodBatch, embedBatchSize: 4, ...FAST });
    const [ma, mb] = [await vecsByText(La), await vecsByText(Lb)];
    check('14c-a. Batched embedding stores the same vectors as per-chunk (batch size 4 → ceil(n/4) calls)',
      ma.size > 0 && ma.size === mb.size && [...ma].every(([t, v]) => mb.get(t) === v) && batchCalls.length === Math.ceil(ma.size / 4)
        && (await versionRows(Lb))[0].status === 'ACTIVE',
      `chunks=${ma.size} batchCalls=${batchCalls.join(',')}`);

    // (b) one bad text inside a batch fails only that chunk (others stored; version not activated)
    const Lc = await newLecture('batch-bad-text');
    const pc = await prepareDatasetVersion(Lc, makeXlsx(baseRows(6)));
    const badText = (await query<{ chunk_text: string }>(
      `SELECT c.chunk_text FROM dataset_version_chunks d JOIN lecture_qna_chunks c ON c.id = d.chunk_id WHERE d.version_id = $1 ORDER BY c.id OFFSET 2 LIMIT 1`,
      [pc.kind === 'CREATED' ? pc.versionId : 0])).rows[0].chunk_text;
    const singles: string[] = [];
    const picky = async (t: string) => { singles.push(t); if (t === badText) throw new Error('injected bad text'); return vecFor(t); };
    const pickyBatch = async (texts: string[]) => { if (texts.includes(badText)) throw new Error('injected bad text in batch'); return texts.map(vecFor); };
    const rc = pc.kind === 'CREATED' ? await finishDatasetVersion(pc.versionId, { embed: picky, embedBatch: pickyBatch, embedBatchSize: 32, ...FAST, retryDelayMs: 600_000 }) : null;
    const missing = (await query<{ chunk_text: string }>(
      `SELECT c.chunk_text FROM dataset_version_chunks d JOIN lecture_qna_chunks c ON c.id = d.chunk_id WHERE d.version_id = $1 AND c.local_embedding IS NULL`,
      [pc.kind === 'CREATED' ? pc.versionId : 0])).rows;
    const totalC = await countOne('SELECT count(*) AS n FROM dataset_version_chunks WHERE version_id = $1', [pc.kind === 'CREATED' ? pc.versionId : 0]);
    check('14c-b. One bad text inside a batch fails only that chunk: the rest of the batch is stored via the chunk-by-chunk fallback',
      rc?.outcome === 'PAUSED' && missing.length === 1 && missing[0].chunk_text === badText && (await vecsByText(Lc)).size === totalC - 1,
      `outcome=${rc?.outcome} stillMissing=${missing.length} stored=${(await vecsByText(Lc)).size}`);

    // (c) outage in the middle of a batched build: PAUSED (attempts kept), resumes by itself, progress reaches total
    const Ld = await newLecture('batch-outage');
    const pd = await prepareDatasetVersion(Ld, makeXlsx(baseRows(9)));
    let up = false; let n = 0;
    const flakyBatch = async (texts: string[]) => {
      if (n++ >= 1 && !up) throw new EmbeddingUnavailableError('simulated outage mid-build');   // first batch ok, then down
      return texts.map(vecFor);
    };
    const rd = pd.kind === 'CREATED' ? await finishDatasetVersion(pd.versionId, { embedBatch: flakyBatch, embedBatchSize: 3, retryDelayMs: 40, chunkBackoffMs: 1, maxAttempts: 2 }) : null;
    await new Promise(r => setTimeout(r, 300));
    const dv = (await query<{ status: string; attempts: number; last_error: string | null }>('SELECT status, attempts, last_error FROM dataset_versions WHERE lecture_id = $1', [Ld])).rows[0];
    const storedDuring = (await vecsByText(Ld)).size;
    up = true;
    let st = '';
    for (let i = 0; i < 50; i++) { await new Promise(r => setTimeout(r, 100)); st = (await versionRows(Ld))[0].status; if (st === 'ACTIVE') break; }
    const prog = await progressOf(Ld);
    check('14c-c. Outage in the middle of a batched build pauses (BUILDING, attempts not consumed, first batch kept) and resumes by itself to ACTIVE',
      rd?.outcome === 'PAUSED' && dv.status === 'BUILDING' && dv.attempts === 0 && /unavailable/i.test(dv.last_error ?? '') && storedDuring === 3
        && st === 'ACTIVE' && (await vecsByText(Ld)).size > 3 && (await lectureState(Ld)).status === 'READY' && prog.t > 0 && prog.c === prog.t,
      `outcome=${rd?.outcome} duringOutage=${dv.status}/attempts=${dv.attempts}/stored=${storedDuring} → ${st} progress=${prog.c}/${prog.t}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 15. Simultaneous uploads on one lecture
  // ─────────────────────────────────────────────────────────────────────
  {
    const L7 = await newLecture('simultaneous');
    embedder.reset();
    const f = (n: number) => makeXlsx(baseRows(n));
    const settled = await Promise.allSettled([prepareDatasetVersion(L7, f(5)), prepareDatasetVersion(L7, f(6)), prepareDatasetVersion(L7, f(7)), prepareDatasetVersion(L7, f(8))]);
    const created = settled.filter(r => r.status === 'fulfilled' && (r.value as { kind: string }).kind === 'CREATED') as PromiseFulfilledResult<{ kind: 'CREATED'; versionId: number }>[];
    const rejected = settled.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    const vers = await versionRows(L7);
    const members = created.length ? await countOne('SELECT COUNT(*) n FROM dataset_version_chunks WHERE version_id = $1', [created[0].value.versionId]) : -1;
    const chunkRows = await countOne('SELECT COUNT(*) n FROM lecture_qna_chunks WHERE lecture_id = $1', [L7]);
    if (created.length) await fin(created[0].value.versionId);
    const act = await activeChunks(L7);
    check('15. Four simultaneous uploads on one lecture → exactly one builds, the other three get 409; no mixed or orphan rows',
      created.length === 1 && rejected.length === 3 && rejected.every(r => /in progress/i.test((r.reason as Error).message)) && vers.length === 1
        && members === chunkRows && act.length === chunkRows,
      `created=${created.length} rejected409=${rejected.length} versions=${vers.length} membersOfWinner=${members} chunkRowsInLecture=${chunkRows} activeAfterFinish=${act.length}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 16. A request pinned to a version is not affected by a publish that lands mid-request
  // ─────────────────────────────────────────────────────────────────────
  {
    const L8 = await newLecture('pinned');
    embedder.reset();
    const p = await prepareDatasetVersion(L8, makeXlsx(baseRows(6)));
    if (p.kind === 'CREATED') await fin(p.versionId);
    const pinned = (await lectureState(L8)).active_version_id!;
    const probe = (await query<{ chunk_text: string }>('SELECT c.chunk_text FROM lecture_qna_chunks c JOIN dataset_version_chunks d ON d.chunk_id=c.id WHERE d.version_id=$1 AND c.question=$2', [pinned, baseRows()[1].question])).rows[0].chunk_text;
    const step1 = await searchChunks(vecFor(probe), L8, 3, pinned);              // "retrieval step 1" of a long request
    // ── a new version is published while that request is still running ──
    const edited = baseRows(6); edited[1] = { ...edited[1], answer: 'Concept 2 now says something different.' };
    const p2 = await prepareDatasetVersion(L8, makeXlsx(edited));
    if (p2.kind === 'CREATED') await fin(p2.versionId);
    const nowActive = (await lectureState(L8)).active_version_id!;
    const editedProbe = (await query<{ chunk_text: string }>('SELECT c.chunk_text FROM lecture_qna_chunks c JOIN dataset_version_chunks d ON d.chunk_id=c.id WHERE d.version_id=$1 AND c.question=$2', [nowActive, baseRows()[1].question])).rows[0].chunk_text;
    const step2Pinned = await searchChunks(vecFor(probe), L8, 3, pinned);        // "retrieval step 2" of the SAME request (pinned)
    const step2PinnedNew = await searchChunks(vecFor(editedProbe), L8, 3, pinned);
    const freshOld = await searchChunks(vecFor(probe), L8, 3);                   // a NEW request (not pinned): sees the new version
    const freshNew = await searchChunks(vecFor(editedProbe), L8, 3);
    check('16. Pinned request keeps seeing its own version after a publish (no mixing); a new request sees the new version',
      nowActive !== pinned && step1[0]?.answer === baseRows()[1].answer && step2Pinned[0]?.answer === baseRows()[1].answer && step2PinnedNew.length === 0
        && freshOld.length === 0 && freshNew[0]?.answer === 'Concept 2 now says something different.',
      `pinnedBefore=${step1[0]?.answer === baseRows()[1].answer} pinnedAfterPublish=old:${step2Pinned[0]?.answer === baseRows()[1].answer}/seesNew:${step2PinnedNew.length > 0} newRequest=sees old:${freshOld.length > 0}/sees new:${freshNew.length > 0}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 17. One readiness definition, enforced by chat's gate
  // ─────────────────────────────────────────────────────────────────────
  {
    const student = await createStudent();
    const ask = async (lectureId: number) => {
      try {
        await askLectureAgent({ studentId: student, lectureId, question: 'What does test concept number 1 mean?', sessionId: 0 });
        return { threw: false, status: 0, message: '' };
      } catch (e) {
        const err = e as { statusCode?: number; message: string };
        return { threw: true, status: err.statusCode ?? 0, message: err.message };
      }
    };
    const notReadyMsg = /not ready for this lecture/;

    // Same as ask(), but persists the trace into rag_request_log (awaited) and returns that row.
    const askLogged = async (lectureId: number) => {
      const writes: Promise<void>[] = [];
      await askLectureAgent(
        { studentId: student, lectureId, question: 'What does test concept number 1 mean?', sessionId: 0 },
        { onTraceComplete: t => { writes.push(writeRequestLog(buildRequestLogRow(t, false))); } },
      ).catch(() => undefined);
      await Promise.all(writes);
      return (await query<{ response_status: string; not_found_reason: string | null }>(
        `SELECT response_status, not_found_reason FROM rag_request_log WHERE lecture_id = $1 ORDER BY created_at DESC LIMIT 1`, [lectureId])).rows[0];
    };

    // (a) READY by status, but no active version
    const La = await newLecture('17a status READY, no active version');
    await query(`UPDATE lectures SET status = 'READY' WHERE id = $1`, [La]);
    const ra = await getLectureReadiness(La);
    const aa = await ask(La);
    check('17a. READY lecture with active_version_id NULL → not ready, chat answers LECTURE_NOT_READY (not NOT_FOUND)',
      !ra.ready && /^NO_ACTIVE_VERSION/.test(ra.reason) && aa.threw && aa.status === 400 && notReadyMsg.test(aa.message),
      `readiness=${JSON.stringify(ra)} chat=${aa.status}:${aa.message}`);
    const la = await askLogged(La);
    check('17a-log. The LECTURE_NOT_READY request-log row carries the readiness reason (NO_ACTIVE_VERSION)',
      la?.response_status === 'LECTURE_NOT_READY' && la.not_found_reason === 'NO_ACTIVE_VERSION', `row=${JSON.stringify(la)}`);

    // (c) healthy lecture built by the real pipeline
    const Lc = await newLecture('17c healthy');
    const pc = await prepareDatasetVersion(Lc, makeXlsx(baseRows(6)));
    if (pc.kind === 'CREATED') await fin(pc.versionId);
    const rc = await getLectureReadiness(Lc);
    check('17c. Healthy lecture (active version, every chunk embedded with the current model) → ready',
      rc.ready && (await lectureState(Lc)).status === 'READY', `readiness=${JSON.stringify(rc)}`);

    // (b) same lecture, one chunk of the active version loses its embedding
    await query(`UPDATE lecture_qna_chunks SET local_embedding = NULL
                 WHERE id = (SELECT MIN(c.id) FROM lecture_qna_chunks c JOIN dataset_version_chunks d ON d.chunk_id = c.id
                             WHERE d.version_id = (SELECT active_version_id FROM lectures WHERE id = $1))`, [Lc]);
    const rb = await getLectureReadiness(Lc);
    const ab = await ask(Lc);
    check('17b. READY lecture whose active version has a chunk with NULL local_embedding → not ready, chat answers LECTURE_NOT_READY',
      (await lectureState(Lc)).status === 'READY' && !rb.ready && /^MISSING_EMBEDDINGS: 1\//.test(rb.reason)
        && ab.threw && ab.status === 400 && notReadyMsg.test(ab.message),
      `readiness=${JSON.stringify(rb)} chat=${ab.status}:${ab.message}`);
    const lb = await askLogged(Lc);
    check('17b-log. A MISSING_EMBEDDINGS not-ready row carries the reason with its n/total counts',
      lb?.response_status === 'LECTURE_NOT_READY' && /^MISSING_EMBEDDINGS 1\/\d+$/.test(lb.not_found_reason ?? ''), `row=${JSON.stringify(lb)}`);

    // a chunk embedded by a different model also makes it not ready
    await query(`UPDATE lecture_qna_chunks SET local_embedding = $2::vector WHERE local_embedding IS NULL AND lecture_id = $1`, [Lc, `[${vecFor('x').join(',')}]`]);
    await query(`UPDATE lecture_qna_chunks SET embedding_model_version = 'old-model' WHERE id = (SELECT MIN(id) FROM lecture_qna_chunks WHERE lecture_id = $1)`, [Lc]);
    const rs = await getLectureReadiness(Lc);
    check('17d. A chunk embedded by a different model version → not ready (stale model)',
      !rs.ready && /^STALE_EMBEDDING_MODEL: 1\//.test(rs.reason), `readiness=${JSON.stringify(rs)}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 18. Model-consistent MERGE: carried-over Q&As never bring an old model into a new version
  // ─────────────────────────────────────────────────────────────────────
  {
    const modelCounts = async (lectureId: number) => (await query<{ m: string | null; n: string }>(
      `SELECT c.embedding_model_version AS m, COUNT(*) AS n
       FROM lectures l JOIN dataset_version_chunks d ON d.version_id = l.active_version_id JOIN lecture_qna_chunks c ON c.id = d.chunk_id
       WHERE l.id = $1 GROUP BY 1`, [lectureId])).rows.map(r => `${r.m}:${r.n}`).join(',');

    // (a) model changed, then a PARTIAL merge (2 of 6 rows in the file)
    const La = await newLecture('18a model change + partial merge');
    embedder.reset();
    const pa = await prepareDatasetVersion(La, makeXlsx(baseRows(6)));
    if (pa.kind === 'CREATED') await fin(pa.versionId);
    const oldActive = (await lectureState(La)).active_version_id!;
    const before = await activeChunks(La);
    const qaIdsBefore = [...new Set(before.map(c => c.qa_id))].sort();
    await query(`UPDATE lecture_qna_chunks SET embedding_model_version = 'old-model:768' WHERE lecture_id = $1`, [La]);
    const dry = await prepareDatasetVersion(La, makeXlsx(baseRows(6).slice(0, 2)), { dryRun: true });
    embedder.reset();
    const pa2 = await prepareDatasetVersion(La, makeXlsx(baseRows(6).slice(0, 2)));
    if (pa2.kind === 'CREATED') await fin(pa2.versionId);
    const after = await activeChunks(La);
    const qaIdsAfter = [...new Set(after.map(c => c.qa_id))].sort();
    const mc = await modelCounts(La);
    const oldRowsUntouched = await countOne(
      `SELECT COUNT(*) n FROM lecture_qna_chunks c JOIN dataset_version_chunks d ON d.chunk_id = c.id
       WHERE d.version_id = $1 AND c.embedding_model_version = 'old-model:768' AND c.local_embedding IS NOT NULL`, [oldActive]);
    check('18a. Model change + partial MERGE → every chunk of the new active version is on the current model; carried Q&As keep their qa_id; old version rows untouched',
      dry.kind === 'DRY_RUN' && dry.preview.reembeddedForModel === 4 && dry.preview.carriedOver === 0
        && pa2.kind === 'CREATED' && pa2.preview.reembeddedForModel === 4
        && mc === `${EMBEDDING_MODEL_VERSION}:${after.length}` && after.length === before.length
        && JSON.stringify(qaIdsAfter) === JSON.stringify(qaIdsBefore)
        && embedder.calls.length === after.length && oldRowsUntouched === before.length,
      `models=${mc} reembeddedForModel=${pa2.kind === 'CREATED' ? pa2.preview.reembeddedForModel : '?'} qaIdsKept=${JSON.stringify(qaIdsAfter) === JSON.stringify(qaIdsBefore)} embedCalls=${embedder.calls.length}/${after.length} oldRowsUntouched=${oldRowsUntouched}/${before.length}`);

    // a MERGE whose only work is re-embedding for the model change is not a NOOP
    await query(`UPDATE lecture_qna_chunks SET embedding_model_version = 'old-model:768'
                 WHERE id IN (SELECT d.chunk_id FROM dataset_version_chunks d JOIN lectures l ON l.active_version_id = d.version_id
                              WHERE l.id = $1 AND d.qa_id = $2)`, [La, after[after.length - 1].qa_id]);
    const lastQa = after[after.length - 1].qa_id;
    embedder.reset();
    const missingOnly = await prepareDatasetVersion(La, makeXlsx(baseRows(6).slice(0, 2)));
    if (missingOnly.kind === 'CREATED') await fin(missingOnly.versionId);
    check('18a2. A MERGE whose only work is re-embedding a carried Q&A for the model change is not a NOOP, and fixes just that Q&A',
      missingOnly.kind === 'CREATED' && missingOnly.preview.added === 0 && missingOnly.preview.updated === 0
        && missingOnly.preview.reembeddedForModel === 1 && missingOnly.preview.carriedOver === 3
        && (await modelCounts(La)) === `${EMBEDDING_MODEL_VERSION}:${after.length}`,
      `kind=${missingOnly.kind} reembeddedForModel=${missingOnly.kind === 'CREATED' ? missingOnly.preview.reembeddedForModel : '?'} (stale qa ${lastQa}) embedCalls=${embedder.calls.length}`);

    // (b) validateVersion rejects a version holding one old-model chunk
    const Lb = await newLecture('18b validate model');
    embedder.reset();
    const pb = await prepareDatasetVersion(Lb, makeXlsx(baseRows(4)));
    if (pb.kind === 'CREATED') await fin(pb.versionId);
    const vb = (await lectureState(Lb)).active_version_id!;
    const okProblems = await validateVersion(vb);
    await query(`UPDATE lecture_qna_chunks SET embedding_model_version = 'old-model:768'
                 WHERE id = (SELECT MIN(chunk_id) FROM dataset_version_chunks WHERE version_id = $1)`, [vb]);
    const badProblems = await validateVersion(vb);
    check('18b. validateVersion rejects a version with one old-model chunk (and accepts it before)',
      okProblems.length === 0 && badProblems.some(x => /different model/.test(x)),
      `before=${JSON.stringify(okProblems)} after=${JSON.stringify(badProblems)}`);

    // (c) no model change: partial MERGE still carries over, carried Q&As are not embedded
    const Lc2 = await newLecture('18c no model change');
    embedder.reset();
    const pc = await prepareDatasetVersion(Lc2, makeXlsx(baseRows(6)));
    if (pc.kind === 'CREATED') await fin(pc.versionId);
    const beforeC = await activeChunks(Lc2);
    const edited = baseRows(6).slice(0, 1); edited[0] = { ...edited[0], answer: 'Concept 1 was edited for the 18c test.' };
    embedder.reset();
    const pc2 = await prepareDatasetVersion(Lc2, makeXlsx(edited));
    if (pc2.kind === 'CREATED') await fin(pc2.versionId);
    const afterC = await activeChunks(Lc2);
    const carriedIds = new Set(beforeC.filter(c => c.question !== edited[0].question).map(c => c.id));
    const carriedStill = afterC.filter(c => carriedIds.has(c.id)).length;
    const carriedTexts = new Set((await query<{ chunk_text: string }>(
      'SELECT chunk_text FROM lecture_qna_chunks WHERE id = ANY($1::int[])', [[...carriedIds]])).rows.map(r => r.chunk_text));
    check('18c. Without a model change a partial MERGE still carries Q&As over as the same rows, and embeds none of them',
      pc2.kind === 'CREATED' && pc2.preview.carriedOver === 5 && pc2.preview.reembeddedForModel === 0
        && carriedStill === carriedIds.size && afterC.length === beforeC.length
        && embedder.calls.every(t => !carriedTexts.has(t)) && embedder.calls.length > 0 && embedder.calls.length <= 2
        && (await modelCounts(Lc2)) === `${EMBEDDING_MODEL_VERSION}:${afterC.length}`,
      `carried=${pc2.kind === 'CREATED' ? pc2.preview.carriedOver : '?'} sameRowsKept=${carriedStill}/${carriedIds.size} embedCalls=${embedder.calls.length} (edited row only)`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 19. Rollback validates the version it restores
  // ─────────────────────────────────────────────────────────────────────
  {
    const L = await newLecture('19 rollback validation');
    embedder.reset();
    const p1 = await prepareDatasetVersion(L, makeXlsx(baseRows(4)));
    if (p1.kind === 'CREATED') await fin(p1.versionId);
    const p2 = await prepareDatasetVersion(L, makeXlsx(baseRows(5)));
    if (p2.kind === 'CREATED') await fin(p2.versionId);
    const v1 = p1.kind === 'CREATED' ? p1.versionId : -1;
    const v2 = p2.kind === 'CREATED' ? p2.versionId : -1;
    const chunkOfV1 = await countOne('SELECT MIN(chunk_id) n FROM dataset_version_chunks WHERE version_id = $1', [v1]);
    await query(`UPDATE lecture_qna_chunks SET embedding_model_version = 'old-model:768' WHERE id = $1`, [chunkOfV1]);
    const refused = await expectReject(rollbackDataset(L));
    const st = await lectureState(L);
    const vs = await versionRows(L);
    check('19a. Rollback to a version with one old-model chunk is refused (409) and the active version stays the same',
      refused.rejected && /previous version cannot be restored/.test(refused.message) && /different model/.test(refused.message)
        && (refused.err as { statusCode?: number }).statusCode === 409
        && st.active_version_id === v2 && st.status === 'READY'
        && vs.find(v => v.id === v1)?.status === 'SUPERSEDED' && vs.find(v => v.id === v2)?.status === 'ACTIVE',
      `message="${refused.message.slice(0, 120)}" active=${st.active_version_id} (expected ${v2})`);
    await query(`UPDATE lecture_qna_chunks SET embedding_model_version = $2 WHERE id = $1`, [chunkOfV1, EMBEDDING_MODEL_VERSION]);
    const rbOk = await rollbackDataset(L);
    check('19b. Once the version is healthy again the same rollback succeeds', rbOk.activeVersionId === v1, `active=${rbOk.activeVersionId} (expected ${v1})`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 20. Legacy retry: only the ACTIVE version's missing vectors, never orphans / other-model vectors
  // ─────────────────────────────────────────────────────────────────────
  {
    const vecOf = async (id: number) => (await query<{ v: string | null; m: string | null }>(
      'SELECT local_embedding::text AS v, embedding_model_version AS m FROM lecture_qna_chunks WHERE id = $1', [id])).rows[0];
    const build = async (tag: string) => {
      const L = await newLecture(tag);
      embedder.reset();
      const p = await prepareDatasetVersion(L, makeXlsx(baseRows(4)));
      if (p.kind === 'CREATED') await fin(p.versionId);
      const members = (await activeChunks(L)).map(c => c.id);
      return { L, members };
    };
    const orphanFor = async (L: number) => (await query<{ id: number }>(
      `INSERT INTO lecture_qna_chunks (lecture_id, question, answer, chunk_text) VALUES ($1, 'orphan q', 'orphan a', 'orphan chunk text') RETURNING id`, [L])).rows[0].id;

    // (a) NULL member + orphan + other-model member
    const A = await build('20a retry mixed');
    const orphan = await orphanFor(A.L);
    const [nullMember, otherMember] = A.members;
    await query(`UPDATE lecture_qna_chunks SET local_embedding = NULL, embedding_model_version = NULL WHERE id = $1`, [nullMember]);
    await query(`UPDATE lecture_qna_chunks SET embedding_model_version = 'old-model:768' WHERE id = $1`, [otherMember]);
    const otherBefore = await vecOf(otherMember);
    const nullText = (await query<{ chunk_text: string }>('SELECT chunk_text FROM lecture_qna_chunks WHERE id = $1', [nullMember])).rows[0].chunk_text;
    embedder.reset();
    const r1 = await retryMissingEmbeddings(A.L, { embed: embedder.embed });
    const nm = await vecOf(nullMember), om = await vecOf(otherMember), orph = await vecOf(orphan);
    check('20a. Retry embeds the active version\'s NULL chunk with the model version; the orphan and the other-model vector are untouched; lecture not set to EMBEDDING',
      r1.embedded === 1 && embedder.calls.length === 1 && embedder.calls[0] === nullText
        && nm.v !== null && nm.m === EMBEDDING_MODEL_VERSION
        && orph.v === null && om.v === otherBefore.v && om.m === 'old-model:768'
        && r1.otherModel === 1 && r1.exitCode === 1 && /export the dataset and re-upload/.test(r1.message)
        && (await lectureState(A.L)).status === 'READY',
      `embedded=${r1.embedded} calls=${embedder.calls.length} nullChunkModel=${nm.m} orphanVector=${orph.v === null ? 'none' : 'SET'} otherModelKept=${om.m} exit=${r1.exitCode}`);

    // once the other-model chunk is healthy, a repeat run has nothing to do
    await query(`UPDATE lecture_qna_chunks SET embedding_model_version = $2 WHERE id = $1`, [otherMember, EMBEDDING_MODEL_VERSION]);
    embedder.reset();
    const r2 = await retryMissingEmbeddings(A.L, { embed: embedder.embed });
    check('20b. Ready lecture → "nothing to do", exit 0, no embedding calls, orphan still without a vector',
      r2.exitCode === 0 && /Nothing to do/.test(r2.message) && embedder.calls.length === 0 && (await vecOf(orphan)).v === null, `exit=${r2.exitCode} calls=${embedder.calls.length}`);

    // (c) the only gap is a NULL member: lecture is set READY when readiness agrees
    const C = await build('20c retry sets READY');
    await query(`UPDATE lecture_qna_chunks SET local_embedding = NULL, embedding_model_version = NULL WHERE id = $1`, [C.members[0]]);
    await query(`UPDATE lectures SET status = 'FAILED' WHERE id = $1`, [C.L]);
    embedder.reset();
    const r3 = await retryMissingEmbeddings(C.L, { embed: embedder.embed });
    check('20c. When the active version ends fully embedded on the current model, the lecture is set READY',
      r3.exitCode === 0 && r3.embedded === 1 && (await lectureState(C.L)).status === 'READY', `exit=${r3.exitCode} status=${(await lectureState(C.L)).status}`);

    // (d) no active version → exit 1, nothing written
    const D = await newLecture('20d no active version');
    const dChunk = (await query<{ id: number }>(
      `INSERT INTO lecture_qna_chunks (lecture_id, question, answer, chunk_text) VALUES ($1, 'q', 'a', 'legacy chunk without version') RETURNING id`, [D])).rows[0].id;
    const snap = async () => JSON.stringify([
      (await query('SELECT status, active_version_id, progress_current, progress_total, updated_at FROM lectures WHERE id = $1', [D])).rows,
      (await query('SELECT id, local_embedding IS NULL AS n, embedding_model_version FROM lecture_qna_chunks WHERE lecture_id = $1 ORDER BY id', [D])).rows,
      await countOne('SELECT COUNT(*) n FROM dataset_versions WHERE lecture_id = $1', [D]),
    ]);
    const s0 = await snap();
    embedder.reset();
    const r4 = await retryMissingEmbeddings(D, { embed: embedder.embed });
    const cli = await new Promise<{ code: number | null; out: string }>(resolve => {
      const ch = spawn(TSNODE, ['--transpile-only', join(__dirname, 'retry-missing-embeddings.ts'), String(D)], { env: process.env });
      let out = ''; ch.stdout.on('data', d => { out += d; }); ch.stderr.on('data', d => { out += d; });
      ch.on('close', code => resolve({ code, out }));
    });
    check('20d. Lecture with no active version: exit 1 with the upload message, nothing embedded, nothing written (function and CLI)',
      r4.exitCode === 1 && /no active dataset version — upload its dataset from the admin page/.test(r4.message)
        && embedder.calls.length === 0 && (await snap()) === s0 && (await vecOf(dChunk)).v === null
        && cli.code === 1 && /upload its dataset from the admin page/.test(cli.out) && (await snap()) === s0,
      `fn exit=${r4.exitCode} cli exit=${cli.code} unchanged=${(await snap()) === s0}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 21. P7 guardrails: possible duplicates, Final_Dataset sheet, first-version status restore
  // ─────────────────────────────────────────────────────────────────────
  {
    const L = await newLecture('p7-dupes');
    embedder.reset();
    const base = baseRows(6);
    const r1 = await prepareDatasetVersion(L, makeXlsx(base));
    if (r1.kind !== 'CREATED') throw new Error('p7 setup failed');
    await fin(r1.versionId);

    // Question wording corrected, no qa_id column; the rest of the sheet re-uploaded.
    const edited = base.map((r, i) => i === 2 ? { ...r, question: 'What does test concept number 3 really mean' , answer: r.answer + ' Corrected.' } : r);
    const dm = await prepareDatasetVersion(L, makeXlsx(edited), { dryRun: true });
    const dr = await prepareDatasetVersion(L, makeXlsx(edited), { dryRun: true, mode: 'REPLACE', confirmRemovals: 0 });
    // Unrelated new question + different answer.
    const unrelated = [...base, { question: 'Explain gradient descent in a neural network', answer: 'It iteratively moves weights against the loss gradient.', keywords: 'gd' }];
    const um = await prepareDatasetVersion(L, makeXlsx(unrelated), { dryRun: true });
    // Same answer under a completely different question.
    const sameAns = [{ question: 'Totally different phrasing here', answer: `${base[0].answer.replace(/ /g, '  ')}`, keywords: 'x' }, ...base.slice(1)];
    const sm = await prepareDatasetVersion(L, makeXlsx(sameAns), { dryRun: true });
    // Punctuation/case-only edit.
    const punct = [...base.slice(0, 3), { question: 'WHAT does test concept number 4, mean??', answer: 'Brand new answer text.', keywords: 'y' }, ...base.slice(4)];
    const pm = await prepareDatasetVersion(L, makeXlsx(punct), { dryRun: true });
    const dp = dm.preview.possibleDuplicates[0];
    check('21a. MERGE: a question edit without qa_id is flagged as a possible duplicate (with row + existing Q&A)',
      dm.preview.added === 1 && dm.preview.possibleDuplicateCount === 1 && dp?.sheetRow === 4
        && /really mean/.test(dp.newQuestion) && /concept number 3 mean/.test(dp.existingQuestion) && /^qa_/.test(dp.existingQaId)
        && dm.preview.fileHasQaIdColumn === false,
      `count=${dm.preview.possibleDuplicateCount} row=${dp?.sheetRow} hasQaId=${dm.preview.fileHasQaIdColumn}`);
    check('21b. An unrelated new question is not flagged',
      um.preview.added === 1 && um.preview.possibleDuplicateCount === 0 && um.preview.possibleDuplicates.length === 0,
      `count=${um.preview.possibleDuplicateCount}`);
    check('21c. REPLACE flags nothing; same answer (whitespace-normalised) and punctuation-only question edits are flagged under MERGE',
      dr.preview.possibleDuplicateCount === 0 && sm.preview.possibleDuplicateCount === 1 && pm.preview.possibleDuplicateCount === 1,
      `replace=${dr.preview.possibleDuplicateCount} sameAnswer=${sm.preview.possibleDuplicateCount} punct=${pm.preview.possibleDuplicateCount}`);

    // List is capped at 20 but the count is the total.
    const L2 = await newLecture('p7-cap');
    const big = baseRows(30);
    const b2 = await prepareDatasetVersion(L2, makeXlsx(big));
    if (b2.kind !== 'CREATED') throw new Error('p7 cap setup failed');
    await fin(b2.versionId);
    const reworded = big.slice(0, 25).map((r, i) => ({ question: `Reworded capped question ${i} about nothing alike`, answer: r.answer, keywords: 'c' }));
    const cm = await prepareDatasetVersion(L2, makeXlsx([...reworded, ...big.slice(25)]), { dryRun: true });
    check('21d. possibleDuplicates is capped at 20, possibleDuplicateCount is the full total',
      cm.preview.possibleDuplicates.length === 20 && cm.preview.possibleDuplicateCount === 25,
      `listed=${cm.preview.possibleDuplicates.length} total=${cm.preview.possibleDuplicateCount}`);

    // qa_id column present -> fileHasQaIdColumn true.
    const exported = await exportActiveDataset(L);
    const qm = await prepareDatasetVersion(L, exported, { dryRun: true });
    check('21e. A workbook with a qa_id column reports fileHasQaIdColumn=true', qm.preview.fileHasQaIdColumn === true, `has=${qm.preview.fileHasQaIdColumn}`);
  }
  {
    // parseExcel reads Final_Dataset even when it is the second sheet (case-insensitive).
    const ws1 = XLSX.utils.json_to_sheet([{ Note: 'cover sheet', Text: 'not a dataset' }]);
    const ws2 = XLSX.utils.json_to_sheet([{ ID: 1, Question: 'Q from final', Answer: 'A from final', Source: 's' }]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, 'Summary');
    XLSX.utils.book_append_sheet(wb, ws2, 'final_dataset');
    const rows2 = parseExcel(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
    const only = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(only, XLSX.utils.json_to_sheet([{ Question: 'Q first', Answer: 'A first' }]), 'Whatever');
    const rows1 = parseExcel(XLSX.write(only, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
    check('21f. parseExcel reads the Final_Dataset sheet when it is not first; otherwise the first sheet',
      rows2.length === 1 && rows2[0].question === 'Q from final' && rows1.length === 1 && rows1[0].question === 'Q first',
      `multi=${rows2[0]?.question} single=${rows1[0]?.question}`);
  }
  {
    // First-version upload: if the build is refused after beforeBuild set DATASET_UPLOADED, the status goes back.
    const L = await newLecture('p7-status');
    const before = (await lectureState(L)).status;
    const res = await expectReject(prepareDatasetVersion(L, makeXlsx(baseRows(3)), {
      beforeBuild: async () => {
        await query(`UPDATE lectures SET status = 'DATASET_UPLOADED' WHERE id = $1`, [L]);
        // A concurrent BUILDING version makes buildVersion refuse with a 409.
        await query(
          `INSERT INTO dataset_versions (lecture_id, version_no, status, mode, embedding_model_version, chunking_config_version, stats)
           VALUES ($1, 1, 'BUILDING', 'MERGE', $2, 'x', '{}'::jsonb)`, [L, EMBEDDING_MODEL_VERSION]);
      },
    }));
    const after = (await lectureState(L)).status;
    check('21g. First-version upload refused in buildVersion (409) restores the lecture status',
      res.rejected && (res.err as { statusCode?: number }).statusCode === 409 && before !== 'DATASET_UPLOADED' && after === before,
      `rejected=${res.rejected} before=${before} after=${after}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 22. Switching EMBEDDING_PROVIDER changes EMBEDDING_MODEL_VERSION: the lecture is not ready until re-embedded
  // ─────────────────────────────────────────────────────────────────────
  {
    const Ls = await newLecture('22 provider switch');
    embedder.reset();
    const p0 = await prepareDatasetVersion(Ls, makeXlsx(baseRows(6)));
    if (p0.kind === 'CREATED') await fin(p0.versionId);
    const total = (await activeChunks(Ls)).length;
    const parentBefore = await getLectureReadiness(Ls);
    const student = await createStudent();

    // A second process whose EMBEDDING_PROVIDER is openai (fake key; no request is ever made — the embedder is injected).
    const w = spawnSync(TSNODE, ['--transpile-only', __filename, '--worker', 'switch', '0', String(Ls), student], {
      env: { ...process.env, EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-not-used' }, encoding: 'utf8',
    });
    const line = (w.stdout ?? '').split('\n').find(l => l.startsWith('WORKER switched '));
    const o = line ? JSON.parse(line.slice('WORKER switched '.length)) as {
      version: string; readyBefore: { ready: boolean; reason: string }; chat: { threw: boolean; status: number; message: string };
      prepKind: string; embedCalls: number; readyAfter: { ready: boolean; reason: string }; models: string;
    } : null;
    const NEW = 'openai:text-embedding-3-small:1024';

    check('22a. Under EMBEDDING_PROVIDER=openai the model version is openai:text-embedding-3-small:1024 (the local build used another)',
      !!o && o.version === NEW && EMBEDDING_MODEL_VERSION !== NEW && parentBefore.ready,
      `worker=${o?.version} parent=${EMBEDDING_MODEL_VERSION} stderr=${(w.stderr ?? '').slice(0, 120)}`);
    check('22b. Before re-embedding the lecture is NOT ready: STALE_EMBEDDING_MODEL for every chunk, chat answers LECTURE_NOT_READY',
      !!o && !o.readyBefore.ready && new RegExp(`^STALE_EMBEDDING_MODEL: ${total}/${total} .*${NEW}$`).test(o.readyBefore.reason)
        && o.chat.threw && o.chat.status === 400 && /not ready for this lecture/.test(o.chat.message),
      `readiness=${JSON.stringify(o?.readyBefore)} chat=${o?.chat.status}:${o?.chat.message}`);
    check('22c. Export → re-upload with Replace re-embeds EVERY chunk (none reused or copied from the old model) and publishes',
      !!o && o.prepKind === 'CREATED' && o.embedCalls === total && o.models === `${NEW}:${total}`,
      `prep=${o?.prepKind} embedCalls=${o?.embedCalls}/${total} models=${o?.models}`);
    const parentAfter = await getLectureReadiness(Ls);
    check('22d. After re-embedding the lecture is ready under the new model — and stale for the old provider (the version string decides)',
      !!o && o.readyAfter.ready && /^OK: /.test(o.readyAfter.reason) && o.readyAfter.reason.includes(NEW)
        && !parentAfter.ready && /^STALE_EMBEDDING_MODEL: /.test(parentAfter.reason),
      `after=${JSON.stringify(o?.readyAfter)} parentNow=${parentAfter.reason}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 23. A raced / in-doubt activation can never fail or purge the live version (A1)
  // ─────────────────────────────────────────────────────────────────────
  {
    const L = await newLecture('23 activation race');
    embedder.reset();
    const p1 = await prepareDatasetVersion(L, makeXlsx(baseRows(4)));
    if (p1.kind === 'CREATED') await fin(p1.versionId);
    const p2 = await prepareDatasetVersion(L, makeXlsx(baseRows(5)));
    const v2 = p2.kind === 'CREATED' ? p2.versionId : -1;
    // Another process switches the lecture to v2 between our read and our switch.
    const raced = await fin(v2, { beforeActivate: () => activateManually(L, v2) });
    const st = await lectureState(L);
    const chunks = await activeChunks(L);
    const vs = await versionRows(L);
    const ready = await getLectureReadiness(L);
    check('23a. Losing an activation race → SKIPPED; the version stays ACTIVE with all its chunks, lecture READY and ready (nothing failed or purged)',
      raced.outcome === 'SKIPPED' && st.active_version_id === v2 && st.status === 'READY'
        && vs.find(v => v.id === v2)?.status === 'ACTIVE' && chunks.length > 0 && chunks.every(c => c.has_vec) && ready.ready,
      `outcome=${raced.outcome} active=${st.active_version_id} (v2=${v2}) status=${st.status} v2Status=${vs.find(v => v.id === v2)?.status} chunks=${chunks.length} ready=${ready.reason}`);

    const before = chunks.length;
    const f = await failDatasetVersion(v2, 'simulated in-doubt COMMIT');
    const vsF = await versionRows(L);
    check('23b. Failing the live version (stale row / in-doubt COMMIT) is a no-op: still ACTIVE, still READY, chunks intact',
      f.outcome === 'SKIPPED' && vsF.find(v => v.id === v2)?.status === 'ACTIVE' && (await lectureState(L)).status === 'READY'
        && (await activeChunks(L)).length === before,
      `outcome=${f.outcome} v2Status=${vsF.find(v => v.id === v2)?.status} chunks=${(await activeChunks(L)).length}/${before}`);

    // State the old bug left behind: the live version's row says FAILED.
    await query(`UPDATE dataset_versions SET status = 'FAILED' WHERE id = $1`, [v2]);
    const cl = await cleanupOldVersions(L);
    const afterCl = (await activeChunks(L)).length;
    await query(`UPDATE dataset_versions SET status = 'ACTIVE' WHERE id = $1`, [v2]);
    check('23c. Cleanup never purges the version the lecture points at, even if its row says FAILED',
      before > 0 && !cl.purged.includes(v2) && afterCl === before, `purged=${JSON.stringify(cl.purged)} chunks=${afterCl}/${before}`);

    // Two separate OS processes finish the same READY_TO_ACTIVATE version at once
    // (multi-instance deploy, or seed:retry next to the API).
    const p3 = await prepareDatasetVersion(L, makeXlsx(baseRows(6)));
    const v3 = p3.kind === 'CREATED' ? p3.versionId : -1;
    await embedPendingManually(v3);
    const outs = await Promise.all([runWorker(['finish', '0', String(v3)]), runWorker(['finish', '0', String(v3)])]);
    const outcomes = outs.map(o => (JSON.parse(o.split('\n').find(l => l.startsWith('WORKER finished '))?.slice('WORKER finished '.length) ?? '{}') as FinishResultT).outcome).sort();
    const st3 = await lectureState(L);
    const c3 = await activeChunks(L);
    const vs3 = await versionRows(L);
    check('23d. Two processes finishing one version at once → exactly one ACTIVATED, the other SKIPPED; version ACTIVE with all chunks',
      outcomes.join() === 'ACTIVATED,SKIPPED' && st3.active_version_id === v3 && st3.status === 'READY'
        && vs3.find(v => v.id === v3)?.status === 'ACTIVE' && c3.length > 0 && c3.every(c => c.has_vec)
        && (await getLectureReadiness(L)).ready,
      `outcomes=${outcomes.join()} active=${st3.active_version_id} (v3=${v3}) v3Status=${vs3.find(v => v.id === v3)?.status} chunks=${c3.length}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 24. No version built under an older embedding model can go live (A3)
  // ─────────────────────────────────────────────────────────────────────
  {
    const OLD = 'old-model:768';
    // (a)+(b) v1 entirely from an old model (chunks AND version stamp agree), v2 re-embedded.
    const L = await newLecture('24 stale model rollback');
    embedder.reset();
    const p1 = await prepareDatasetVersion(L, makeXlsx(baseRows(4)));
    if (p1.kind === 'CREATED') await fin(p1.versionId);
    const v1 = p1.kind === 'CREATED' ? p1.versionId : -1;
    await query(`UPDATE lecture_qna_chunks SET embedding_model_version = $2 WHERE id IN (SELECT chunk_id FROM dataset_version_chunks WHERE version_id = $1)`, [v1, OLD]);
    await query(`UPDATE dataset_versions SET embedding_model_version = $2 WHERE id = $1`, [v1, OLD]);
    const probs = await validateVersion(v1);
    check('24a. validateVersion rejects a version whose chunks match its OWN old stamp but not the live model',
      probs.some(x => /different model than the live one/.test(x)), `problems=${JSON.stringify(probs)}`);

    const p2 = await prepareDatasetVersion(L, makeXlsx(baseRows(4)));
    if (p2.kind === 'CREATED') await fin(p2.versionId);
    const v2 = p2.kind === 'CREATED' ? p2.versionId : -1;
    const rb = await expectReject(rollbackDataset(L));
    const st = await lectureState(L);
    check('24b. Rollback to an old-model version is refused (409); the current-model version stays live and ready',
      p2.kind === 'CREATED' && rb.rejected && (rb.err as { statusCode?: number }).statusCode === 409
        && st.active_version_id === v2 && (await getLectureReadiness(L)).ready,
      `rejected=${rb.rejected} msg="${rb.message.slice(0, 100)}" active=${st.active_version_id} (v2=${v2})`);

    // (c) resume of a READY_TO_ACTIVATE version holding an old-model chunk
    const Lc = await newLecture('24c stale model resume');
    embedder.reset();
    const q1 = await prepareDatasetVersion(Lc, makeXlsx(baseRows(4)));
    if (q1.kind === 'CREATED') await fin(q1.versionId);
    const live = (await lectureState(Lc)).active_version_id;
    const liveChunks = (await activeChunks(Lc)).length;
    const edited = baseRows(4); edited[0] = { ...edited[0], answer: 'Concept 1 was edited for the 24c test.' };
    const q2 = await prepareDatasetVersion(Lc, makeXlsx(edited));
    const w2 = q2.kind === 'CREATED' ? q2.versionId : -1;
    await embedPendingManually(w2);
    await query(
      `UPDATE lecture_qna_chunks SET embedding_model_version = $3 WHERE id IN (
         SELECT chunk_id FROM dataset_version_chunks WHERE version_id = $1
         EXCEPT SELECT chunk_id FROM dataset_version_chunks WHERE version_id = $2)`, [w2, live, OLD]);
    const r = await fin(w2);
    const stc = await lectureState(Lc);
    check('24c. Resuming a READY_TO_ACTIVATE version with an old-model chunk → FAILED, never activated; the previous version stays live and ready',
      r.outcome === 'FAILED' && /different model/.test(r.error ?? '') && stc.active_version_id === live && stc.status === 'READY'
        && (await activeChunks(Lc)).length === liveChunks && (await getLectureReadiness(Lc)).ready,
      `outcome=${r.outcome} error="${(r.error ?? '').slice(0, 100)}" active=${stc.active_version_id} (expected ${live})`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 13. Pure matcher
  // ─────────────────────────────────────────────────────────────────────
  {
    const f = (q: string, a = 'a'): QaFields => ({ topic: null, question: q, answer: a, start_time: null, end_time: null, keywords: null, llm_name: null });
    const row = (q: string, a: string, qaId: string | null, n: number): FileRow => ({ ...f(q, a), qaId, sheetRow: n });
    let c = 0; const id = () => `new${++c}`;
    const active: ActiveQa[] = [{ qaId: 'A', fields: f('dup', '1') }, { qaId: 'B', fields: f('dup', '2') }, { qaId: 'C', fields: f('solo', 's') }];
    const t1 = matchRows([row('dup', '1', null, 2), row('dup', '2', null, 3), row('solo', 's2', null, 4)], active, id);
    const t2 = matchRows([row('dup', 'changed', null, 2)], active, id);
    const t3 = matchRows([row('dup', '1', null, 2), row('dup', '2', null, 3), row('dup', 'third', null, 4)], active, id);
    const t4 = matchRows([row('x', 'x', 'A', 2), row('y', 'y', 'A', 3)], active, id);
    check('13. Matcher: identical dupes re-match; edited dupe is ambiguous; extra dupe beyond existing is new; repeated qa_id errors',
      t1.errors.length === 0 && t1.matches.map(m => m.qaId).join() === 'A,B,C'
        && t2.errors.length === 1 && t3.errors.length === 0 && t3.matches[2].isNew && t4.errors.length === 1,
      `t1=${t1.matches.map(m => m.qaId)} t2err=${t2.errors.length} t3new=${t3.matches[2]?.isNew} t4err=${t4.errors.length}`);
  }
};

// ── main ────────────────────────────────────────────────────────────────

(async () => {
  if (process.argv[2] === '--worker') { await workerMain(); return; }
  try {
    await run();
  } catch (err) {
    console.error('Test run crashed:', err);
    results.push({ name: 'run completed', pass: false, detail: (err as Error).message });
  }
  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log('FAILED: ' + failed.map(f => f.name).join(' | '));
  await pool.end();
  process.exit(failed.length ? 1 : 0);
})();
