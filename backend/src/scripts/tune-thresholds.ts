/**
 * Threshold tuning: finds the VECTOR_SIMILARITY_THRESHOLD / RERANK_MIN_SCORE pair
 * that keeps the most in-scope questions answerable while refusing out-of-scope ones.
 *
 * READ-ONLY. Every database session is opened with default_transaction_read_only=on
 * (checked at startup; the script aborts if it is not in effect), so it may be pointed
 * at askaitutor_dev or at a re-embedded copy. It never writes to the database.
 *
 * It DOES call the configured embedding and rerank providers once per question
 * (free for local-http; paid for openai/voyage — about 2 calls x
 * (lectures x --per-lecture + lectures x --cross-per-lecture) questions). Results are cached,
 * so re-running the sweep, or changing --max-false-accept, costs nothing.
 *
 * Usage:
 *   npm run tune:thresholds -- [--per-lecture 40] [--seed 42] [--cross-per-lecture 40]
 *        [--paraphrases paraphrases.json] [--oos oos.xlsx|oos.csv] [--max-false-accept 0.05]
 *        [--lectures 2,4,5] [--out-dir tune-out] [--cache file.json] [--fresh]
 */
// Must be set before config/database creates its pool; pg reads PGOPTIONS for new connections.
process.env.PGOPTIONS = [process.env.PGOPTIONS, '-c default_transaction_read_only=on'].filter(Boolean).join(' ');

import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';
import {
  CANDIDATE_LIMIT, VECTOR_GRID, RERANK_GRID, answerKeyOf, parseOosRows, recordKey, resolveParaphrase,
  sample, scorePair, subSeed, sweep, toCsv, toMarkdown,
  type CandidateScore, type QuestionRecord,
} from './tune-thresholds-lib';

interface Args {
  perLecture: number; seed: number; crossPerLecture: number; maxFalseAccept: number;
  paraphrases: string | null; oos: string | null; outDir: string; cache: string | null; fresh: boolean; lectures: number[] | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { perLecture: 40, seed: 42, crossPerLecture: 40, maxFalseAccept: 0.05, paraphrases: null, oos: null, outDir: 'tune-out', cache: null, fresh: false, lectures: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} needs a value`);
      return v;
    };
    const num = (): number => {
      const n = Number(val());
      if (!Number.isFinite(n)) throw new Error(`${k} must be a number`);
      return n;
    };
    switch (k) {
      case '--per-lecture': a.perLecture = Math.max(1, Math.floor(num())); break;
      case '--seed': a.seed = Math.floor(num()); break;
      case '--cross-per-lecture': a.crossPerLecture = Math.max(0, Math.floor(num())); break;
      case '--max-false-accept': a.maxFalseAccept = num(); break;
      case '--paraphrases': a.paraphrases = val(); break;
      case '--oos': a.oos = val(); break;
      case '--out-dir': a.outDir = val(); break;
      case '--cache': a.cache = val(); break;
      case '--fresh': a.fresh = true; break;
      case '--lectures': a.lectures = val().split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0); break;
      default: throw new Error(`Unknown option ${k}`);
    }
  }
  if (a.maxFalseAccept < 0 || a.maxFalseAccept > 1) throw new Error('--max-false-accept must be between 0 and 1');
  return a;
}

interface Plan { kind: QuestionRecord['kind']; lectureId: number; question: string; goldQaId?: string; sourceLectureId?: number; usedParaphrase?: boolean }
interface CacheFile { meta: Record<string, unknown>; records: Record<string, QuestionRecord> }

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const { env } = await import('../config/env');
  const { query } = await import('../config/database');
  const { evaluateDbTarget } = await import('./test-db-guard-lib');
  const { generateEmbedding, EMBEDDING_MODEL_VERSION } = await import('../services/embedding.service');
  const { rerankChunks, RERANKER_MODEL_VERSION, DEFAULT_MIN_RERANK_SCORE } = await import('../services/rerank.service');
  const { searchChunkCandidates, SIMILARITY_THRESHOLD } = await import('../services/vector-search.service');
  const { getLectureReadiness } = await import('../services/dataset-version.service');
  const { assertRetrievalProvidersConfigured } = await import('../config/retrieval-providers');

  const t = evaluateDbTarget(process.env);
  const dbLabel = `${t.host}:${t.port}/${t.database}`;
  console.log(`Target database : ${dbLabel}`);
  console.log(`Embedding       : ${EMBEDDING_MODEL_VERSION}  (provider ${env.RETRIEVAL.EMBEDDING_PROVIDER})`);
  console.log(`Reranker        : ${RERANKER_MODEL_VERSION}  (provider ${env.RETRIEVAL.RERANK_PROVIDER})`);
  console.log(`Current values  : VECTOR_SIMILARITY_THRESHOLD=${SIMILARITY_THRESHOLD}  RERANK_MIN_SCORE=${DEFAULT_MIN_RERANK_SCORE}`);

  const ro = (await query<{ default_transaction_read_only: string }>('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only;
  if (ro !== 'on') {
    console.error(`ABORT: the database session is not read-only (default_transaction_read_only=${ro}). Nothing was done.`);
    process.exit(1);
  }
  console.log('Session         : read-only (default_transaction_read_only=on)');
  assertRetrievalProvidersConfigured();

  // ── lectures and their Q&As ────────────────────────────────────
  const { rows: lecRows } = await query<{ id: number; title: string; active_version_id: number }>(
    `SELECT id, title, active_version_id FROM lectures WHERE status = 'READY' AND active_version_id IS NOT NULL ORDER BY id`);
  const lectures: { id: number; versionId: number }[] = [];
  for (const l of lecRows) {
    if (args.lectures && !args.lectures.includes(l.id)) continue;
    const r = await getLectureReadiness(l.id);
    if (!r.ready) { console.log(`Skipping lecture #${l.id}: not ready for the current embedding model (${r.reason})`); continue; }
    lectures.push({ id: l.id, versionId: l.active_version_id });
  }
  if (lectures.length === 0) { console.error('ABORT: no ready lectures to tune against.'); process.exit(1); }
  console.log(`Lectures        : ${lectures.map(l => `#${l.id}`).join(' ')}`);

  const paraphrases: Record<string, string> | null = args.paraphrases
    ? (JSON.parse(fs.readFileSync(args.paraphrases, 'utf8')) as Record<string, string>) : null;

  const qaByLecture = new Map<number, { qaId: string; question: string }[]>();
  const chunkQa = new Map<number, Map<number, string>>(); // lecture -> chunk id -> qa_id
  for (const l of lectures) {
    const { rows } = await query<{ qa_id: string; question: string }>(
      `SELECT d.qa_id, MIN(c.question) AS question
       FROM dataset_version_chunks d JOIN lecture_qna_chunks c ON c.id = d.chunk_id
       WHERE d.version_id = $1 GROUP BY d.qa_id ORDER BY d.qa_id`, [l.versionId]);
    qaByLecture.set(l.id, rows.map(r => ({ qaId: r.qa_id, question: r.question })));
    const { rows: cq } = await query<{ chunk_id: number; qa_id: string }>(
      'SELECT chunk_id, qa_id FROM dataset_version_chunks WHERE version_id = $1', [l.versionId]);
    chunkQa.set(l.id, new Map(cq.map(r => [r.chunk_id, r.qa_id])));
  }

  // ── question plan ──────────────────────────────────────────────
  const plan: Plan[] = [];
  const inScope: Plan[] = [];
  let paraphraseUsed = 0;
  for (const l of lectures) {
    let pool = qaByLecture.get(l.id)!;
    if (paraphrases) {
      const withPara = pool.filter(q => resolveParaphrase(paraphrases, l.id, q.qaId) !== null);
      if (withPara.length < args.perLecture) {
        console.log(`Lecture #${l.id}: only ${withPara.length} Q&A(s) have a paraphrase (wanted ${args.perLecture})`);
      }
      pool = withPara;
    }
    for (const q of sample(pool, args.perLecture, subSeed(args.seed, l.id, 1))) {
      const para = paraphrases ? resolveParaphrase(paraphrases, l.id, q.qaId) : null;
      if (para) paraphraseUsed++;
      const p: Plan = { kind: 'in', lectureId: l.id, question: para ?? q.question, goldQaId: q.qaId, usedParaphrase: !!para };
      inScope.push(p); plan.push(p);
    }
  }
  // (a) cross-lecture negatives: other lectures' in-scope questions, asked against this one.
  for (const l of lectures) {
    const others = inScope.filter(p => p.lectureId !== l.id)
      .sort((x, y) => x.lectureId - y.lectureId || (x.goldQaId! < y.goldQaId! ? -1 : 1));
    for (const o of sample(others, args.crossPerLecture, subSeed(args.seed, l.id, 2))) {
      plan.push({ kind: 'oos-auto', lectureId: l.id, question: o.question, sourceLectureId: o.lectureId });
    }
  }
  // (b) out-of-scope file
  let oosFileCount = 0;
  if (args.oos) {
    const wb = XLSX.readFile(args.oos);
    const sheetName = wb.SheetNames.find(n => /out[_ ]?of[_ ]?scope/i.test(n)) ?? wb.SheetNames[0];
    const parsed = parseOosRows(XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheetName], { defval: '' }));
    const ids = new Set(lectures.map(l => l.id));
    let notTuned = 0;
    for (const r of parsed.rows) {
      if (!ids.has(r.lectureId)) { notTuned++; continue; }
      plan.push({ kind: 'oos-file', lectureId: r.lectureId, question: r.question });
      oosFileCount++;
    }
    console.log(`OOS file        : ${path.basename(args.oos)} [${sheetName}] — ${oosFileCount} used, ${parsed.skipped} malformed, ${notTuned} for lectures not being tuned`);
  }
  const oosAutoCount = plan.filter(p => p.kind === 'oos-auto').length;
  const questionMode = !paraphrases ? 'exact dataset questions'
    : `paraphrases (${paraphraseUsed} of ${inScope.length} in-scope questions)`;
  console.log(`Question wording: ${questionMode}`);
  console.log(`Questions       : ${inScope.length} in-scope, ${oosAutoCount} cross-lecture out-of-scope, ${oosFileCount} out-of-scope from file`);

  // ── run (or load) the real retrieval path once per question ────
  fs.mkdirSync(args.outDir, { recursive: true });
  const cachePath = args.cache ?? path.join(args.outDir, 'cache.json');
  const meta = {
    format: 1, embeddingModelVersion: EMBEDDING_MODEL_VERSION, rerankerModelVersion: RERANKER_MODEL_VERSION, candidateLimit: CANDIDATE_LIMIT,
    versions: Object.fromEntries(lectures.map(l => [l.id, l.versionId])),
  };
  let cache: CacheFile = { meta, records: {} };
  if (!args.fresh && fs.existsSync(cachePath)) {
    const loaded = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as CacheFile;
    if (JSON.stringify(loaded.meta) === JSON.stringify(meta)) {
      cache = loaded;
      console.log(`Cache           : ${cachePath} (${Object.keys(cache.records).length} cached question runs reused)`);
    } else {
      console.log(`Cache           : ${cachePath} was built for different models or dataset versions — ignoring it`);
    }
  }
  const save = (): void => { fs.writeFileSync(cachePath, JSON.stringify(cache)); };

  const embedMemo = new Map<string, number[]>();
  const todo = plan.filter(p => !cache.records[recordKey({ kind: p.kind, lectureId: p.lectureId, goldQaId: p.goldQaId, question: p.question })]);
  console.log(`Retrieval runs  : ${todo.length} to do, ${plan.length - todo.length} cached`);
  const started = Date.now();
  for (let i = 0; i < todo.length; i++) {
    const p = todo[i];
    let vec = embedMemo.get(p.question);
    if (!vec) { vec = await generateEmbedding(p.question, true); embedMemo.set(p.question, vec); }
    const cands = await searchChunkCandidates(vec, p.lectureId, CANDIDATE_LIMIT);
    const reranked = cands.length > 0 ? await rerankChunks(p.question, cands, cands.length) : [];
    const scoreOf = new Map(reranked.map(c => [c.id, c.rerankScore ?? 0]));
    const qaOf = chunkQa.get(p.lectureId)!;
    const candidates: CandidateScore[] = cands.map(c => ({
      chunkId: c.id, qaId: qaOf.get(c.id) ?? '', chunkIndex: c.chunk_index ?? 0, answerKey: answerKeyOf(c.answer),
      similarity: c.similarity ?? 0, rerankScore: scoreOf.get(c.id) ?? 0,
    }));
    const rec: QuestionRecord = { kind: p.kind, lectureId: p.lectureId, question: p.question, goldQaId: p.goldQaId,
      sourceLectureId: p.sourceLectureId, usedParaphrase: p.usedParaphrase, candidates };
    cache.records[recordKey(rec)] = rec;
    if ((i + 1) % 25 === 0 || i === todo.length - 1) {
      save();
      const perItem = (Date.now() - started) / (i + 1);
      console.log(`  ${i + 1}/${todo.length} done · ~${Math.round(perItem * (todo.length - i - 1) / 1000)}s left`);
    }
  }
  if (todo.length > 0) save();

  // ── sweep ──────────────────────────────────────────────────────
  const records = plan.map(p => cache.records[recordKey({ kind: p.kind, lectureId: p.lectureId, goldQaId: p.goldQaId, question: p.question })]);
  const grid = sweep(records, VECTOR_GRID, RERANK_GRID);
  const current = scorePair(records, SIMILARITY_THRESHOLD, DEFAULT_MIN_RERANK_SCORE);
  const onGrid = VECTOR_GRID.some(v => Math.abs(v - SIMILARITY_THRESHOLD) < 1e-9) && RERANK_GRID.some(r => Math.abs(r - DEFAULT_MIN_RERANK_SCORE) < 1e-9);

  const md = toMarkdown(grid, {
    database: dbLabel, embeddingModelVersion: EMBEDDING_MODEL_VERSION, rerankerModelVersion: RERANKER_MODEL_VERSION,
    questionMode, seed: args.seed, perLecture: args.perLecture, lectures: lectures.map(l => l.id),
    inScopeCount: inScope.length, oosAutoCount, oosFileCount, maxFalseAccept: args.maxFalseAccept, current, currentOnGrid: onGrid,
  });
  fs.writeFileSync(path.join(args.outDir, 'grid.csv'), toCsv(grid, args.maxFalseAccept));
  fs.writeFileSync(path.join(args.outDir, 'summary.md'), md);
  console.log(`\nWrote ${path.join(args.outDir, 'grid.csv')} (${grid.length} pairs), ${path.join(args.outDir, 'summary.md')}, ${cachePath}\n`);
  console.log(md);
  const { default: pool } = await import('../config/database');
  await pool.end();
}

main().catch(err => {
  console.error(`tune-thresholds failed: ${(err as Error).message}`);
  process.exit(1);
});
