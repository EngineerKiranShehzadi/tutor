/**
 * Inserts ~500 fake rag_request_log rows spread over the last 30 days so the
 * admin monitor dashboard can be exercised locally. Every row is tagged
 * schema_version = 'seed'; re-running first deletes the previous seed rows.
 * Needs at least one existing lecture. Refuses to run against a non-local DB.
 *
 * Usage: npm run seed:request-log
 */
import { randomBytes } from 'crypto';
import pool, { query } from '../config/database';
import { env } from '../config/env';

const COUNT = 500;
const DAY_MS = 86_400_000;

const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)];
const chance = (p: number): boolean => Math.random() < p;
const between = (lo: number, hi: number): number => lo + Math.floor(Math.random() * (hi - lo + 1));

// Roughly log-normal: most requests are quick, a few are slow.
const jitter = (base: number, spread = 0.5): number =>
  Math.max(1, Math.round(base * Math.exp((Math.random() - 0.5) * 2 * spread)));

const MODEL = 'seed-model';

// Stage names are the ones recordTrace writes into stage_ms (see chat.service.ts).
// Typical duration per stage; anything not listed is a small local step.
const STAGE_MS: Record<string, [number, number]> = {
  'input-guardrail': [150, 500],
  'load-session-history': [10, 60],
  'classify-query-route': [1, 15],
  'rewrite-contextual-query': [300, 1200],
  'exact-memory-lookup': [20, 150],
  'decompose-query': [250, 900],
  'generate-query-embedding': [60, 250],
  'vector-search': [30, 200],
  'rerank-candidates': [300, 3000],
  'generate-grounded-answer': [1500, 8000],
  'output-guardrail': [400, 1500],
  'save-chat-entry': [5, 40],
  'generate-greeting-response': [250, 900],
  'fetch-all-lecture-chunks': [30, 200],
  'summarize-lecture-content': [2500, 9000],
};
const LLM_STAGES = new Set([
  'input-guardrail', 'rewrite-contextual-query', 'decompose-query', 'generate-grounded-answer',
  'output-guardrail', 'generate-greeting-response', 'summarize-lecture-content',
]);

const stageMs = (names: string[]): Record<string, number> =>
  Object.fromEntries(names.map(n => [n, between(...STAGE_MS[n])]));

const RAG_HEAD = ['input-guardrail', 'load-session-history', 'classify-query-route'];

function ragStages(followUp: boolean, upTo: string): string[] {
  const full = [
    ...RAG_HEAD, ...(followUp ? ['rewrite-contextual-query'] : []),
    'exact-memory-lookup', 'decompose-query', 'generate-query-embedding', 'vector-search',
    'rerank-candidates', 'generate-grounded-answer', 'output-guardrail', 'save-chat-entry',
  ];
  return full.slice(0, full.indexOf(upTo) + 1);
}

function buildRow(lectureId: number, lectureBias: number) {
  // Newer days get more traffic.
  const createdAt = new Date(Date.now() - Math.pow(Math.random(), 1.6) * 30 * DAY_MS);

  const followUp = chance(0.3);
  let route: string | null = followUp ? 'CONTEXTUAL_FOLLOW_UP' : 'FACT_QUESTION';
  let status = 'SUCCESS';
  let responseStatus = 'ANSWERED';
  let notFoundReason: string | null = null;
  let errorCode: string | null = null;
  let memoryResult: string | null = 'MISS';
  let verification: string | null = chance(0.08) ? pick(['UNSUPPORTED_CLAIMS', 'ANSWERED_UNCOVERED_ASPECT']) : 'VERIFIED';
  let names = ragStages(followUp, 'save-chat-entry');

  const notFound = 0.04 + lectureBias;
  const roll = Math.random();
  if (roll < 0.04) {
    status = 'ERROR'; responseStatus = 'ERROR'; verification = null;
    errorCode = pick(['LLM_TIMEOUT', 'EMBEDDING_FAILED', 'DB_ERROR']);
    names = ragStages(followUp, pick(['generate-query-embedding', 'rerank-candidates', 'generate-grounded-answer']));
  } else if (roll < 0.04 + notFound) {
    responseStatus = 'NOT_FOUND'; verification = null;
    const stopAtVectorSearch = chance(0.4);
    notFoundReason = stopAtVectorSearch ? 'NO_VECTOR_CANDIDATES' : 'ALL_CANDIDATES_BELOW_RERANK_FLOOR';
    names = ragStages(followUp, stopAtVectorSearch ? 'vector-search' : 'rerank-candidates');
  } else if (roll < 0.04 + notFound + 0.03) {
    responseStatus = 'GUARDRAIL_REJECTED'; route = null; memoryResult = null; verification = null;
    names = ['input-guardrail'];
  } else if (roll < 0.04 + notFound + 0.03 + 0.05) {
    responseStatus = 'GREETING_ANSWERED'; route = 'GREETING'; memoryResult = 'NOT_ATTEMPTED'; verification = null;
    names = [...RAG_HEAD, 'generate-greeting-response', 'save-chat-entry'];
  } else if (roll < 0.04 + notFound + 0.03 + 0.05 + 0.05) {
    responseStatus = 'SUMMARY_ANSWERED'; route = 'LECTURE_SUMMARY'; memoryResult = 'NOT_ATTEMPTED'; verification = null;
    names = [...RAG_HEAD, 'fetch-all-lecture-chunks', 'summarize-lecture-content', 'save-chat-entry'];
  } else if (roll < 0.04 + notFound + 0.03 + 0.05 + 0.05 + 0.12) {
    responseStatus = 'MEMORY_HIT_ANSWERED'; memoryResult = pick(['EXACT_HIT', 'SEMANTIC_HIT']); verification = null;
    names = [...ragStages(followUp, 'exact-memory-lookup'), 'save-chat-entry'];
  }

  const stage = stageMs(names);
  // A small share of requests hit a slow provider call.
  if (chance(0.05) && stage['generate-grounded-answer']) stage['generate-grounded-answer'] += 6000;
  const llmCalls = names.filter(n => LLM_STAGES.has(n)).length;
  // Small unattributed overhead (middleware, serialisation) on top of the stages.
  const totalMs = Object.values(stage).reduce((a, b) => a + b, 0) + between(5, 60);

  const hasTokens = llmCalls > 0;
  const inputTokens = hasTokens ? jitter(900 * llmCalls) : null;
  const outputTokens = hasTokens ? jitter(120 * llmCalls) : null;
  const cost = hasTokens && chance(0.9) ? Number(((inputTokens! / 1e6) * 0.5 + (outputTokens! / 1e6) * 1.5).toFixed(6)) : null;

  return [
    randomBytes(16).toString('hex'), createdAt, lectureId, route, status, responseStatus, notFoundReason,
    errorCode, memoryResult, verification, totalMs, JSON.stringify(stage), llmCalls, inputTokens,
    outputTokens, cost, hasTokens ? MODEL : null,
    status === 'ERROR' || responseStatus === 'NOT_FOUND' || (verification !== 'VERIFIED' && verification !== null) || chance(0.1),
  ];
}

async function main() {
  const url = env.DB.URL || env.DB.HOST;
  if (env.NODE_ENV === 'production' || !/localhost|127\.0\.0\.1/.test(url)) {
    console.error(`Refusing to seed fake rows into a non-local database (${env.DB.URL ? 'DATABASE_URL' : env.DB.HOST}).`);
    process.exit(1);
  }

  const { rows: lectures } = await query<{ id: number }>('SELECT id FROM lectures ORDER BY id');
  if (lectures.length === 0) {
    console.error('No lectures found — create at least one lecture first.');
    process.exit(1);
  }
  // Give each lecture its own not-found tendency so the lectures table is interesting.
  const bias = new Map(lectures.map(l => [l.id, Math.random() * 0.25]));

  const del = await query('DELETE FROM rag_request_log WHERE schema_version = $1', ['seed']);
  const cols = ['trace_id', 'created_at', 'lecture_id', 'route', 'status', 'response_status', 'not_found_reason',
    'error_code', 'memory_result', 'answer_verification_reason', 'total_ms', 'stage_ms', 'llm_calls',
    'input_tokens', 'output_tokens', 'est_cost_usd', 'llm_model', 'exported_to_phoenix'];
  for (let i = 0; i < COUNT; i++) {
    const lectureId = pick(lectures).id;
    const values = [...buildRow(lectureId, bias.get(lectureId)!), 'seed'];
    await query(
      `INSERT INTO rag_request_log (${cols.join(', ')}, schema_version)
       VALUES (${values.map((_, j) => `$${j + 1}`).join(', ')})`,
      values
    );
  }
  console.log(`Removed ${del.rowCount ?? 0} old seed rows, inserted ${COUNT} across ${lectures.length} lecture(s).`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
