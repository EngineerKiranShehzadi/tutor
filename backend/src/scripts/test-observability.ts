/**
 * Validates Phase 1 of the observability layer: root trace + stage spans
 * (tracer.ts), safe metadata, not-found reason codes, Phoenix/OTel safety,
 * Gemini diagnostics, and the /health/live + /health/ready checks.
 *
 * Phase 2 (rag_request_traces/rag_trace_spans persistence, admin GraphQL
 * queries, System Health page) and Phase 3 (alerting, retention) are not
 * covered here — this suite only exercises what Phase 1 actually built.
 *
 * Uses askLectureAgent's existing deps.onTraceComplete seam to capture the
 * FinishedTrace synchronously, the same DI pattern as every other test
 * script in this project — no new test framework.
 *
 * Usage: npm run test:observability
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { env } from '../config/env';
import { query } from '../config/database';
import { QnaChunk } from '../types';
import {
  askLectureAgent,
  createChatSession,
  deleteChatSession,
  AskLectureAgentDeps,
} from '../services/chat.service';
import { checkLiveness, checkReadiness } from '../observability/health.service';
import { withGeminiDiagnostic } from '../observability/gemini-diagnostics';
import type { FinishedTrace } from '../observability/types';

if (!env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not configured.');
  process.exit(1);
}

interface CaseResult { pass: boolean; skip?: boolean; detail?: string; }
interface Case { label: string; run: () => Promise<CaseResult>; }
const cases: Case[] = [];

// Invokes the locally-installed ts-node binary directly rather than via
// `npx` (used by cases 8 and 9 below) — `npx` re-enters the full npm CLI
// (including its background update-notifier network check), which
// occasionally receives a non-JSON response in this environment and
// crashes the child with an unhandled rejection unrelated to anything
// under test. The local binary is a plain node process with no such side
// channel.
const TS_NODE_BIN = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'ts-node');

const fakeChunk = (id: number, lectureId: number, overrides: Partial<QnaChunk> = {}): QnaChunk => ({
  id, lecture_id: lectureId, topic: 'Test', question: 'Q', answer: 'A',
  chunk_text: 'Q: Q\nA: A', start_time: null, end_time: null, keywords: null, ...overrides,
});

const spanNames = (t: FinishedTrace) => t.spans.map(s => s.name);

// ── Shared harness ────────────────────────────────────────────────────

async function withTrace(
  question: string,
  extraDeps: AskLectureAgentDeps,
  ctx: { lectureId: number; studentId: string; sessionId: number }
): Promise<{ trace: FinishedTrace; result: { answer: string; sources: QnaChunk[] } }> {
  let captured: FinishedTrace | null = null;
  const result = await askLectureAgent(
    { studentId: ctx.studentId, lectureId: ctx.lectureId, question, sessionId: ctx.sessionId },
    { ...extraDeps, onTraceComplete: t => { captured = t; } }
  );
  if (!captured) throw new Error('onTraceComplete was never called');
  return { trace: captured, result };
}

async function runTracingChecks(): Promise<Record<string, CaseResult>> {
  const KEYS = ['1', '2', '2b', '3', '4', '5', '6', '7', '10', '11', '12', '13', '14'];
  const { rows: lectureRows } = await query<{ id: number }>(`SELECT id FROM lectures WHERE status = 'READY' LIMIT 1`);
  const { rows: userRows } = await query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
  if (lectureRows.length === 0 || userRows.length === 0) {
    const skip: CaseResult = { pass: false, skip: true, detail: 'SKIPPED — no READY lecture or user found in DB' };
    return Object.fromEntries(KEYS.map(k => [k, skip]));
  }

  const lectureId = lectureRows[0].id;
  const studentId = userRows[0].id;
  const session = await createChatSession(studentId, lectureId);
  const ctx = { lectureId, studentId, sessionId: session.id };
  const results: Record<string, CaseResult> = {};

  const factDeps: AskLectureAgentDeps = {
    classifyRoute: async () => ({ route: 'FACT_QUESTION', source: 'rule' }),
    generateEmbedding: async () => new Array(8).fill(0.1),
    searchChunks: async () => [fakeChunk(1, lectureId, { similarity: 0.91 })],
    rerankChunks: async (_q, c) => c.map(x => ({ ...x, rerankScore: 0.9 })),
    generateAnswer: async () => 'DISTINCTIVE_ANSWER_TOKEN_ZR7',
    lookupAnswerMemory: async () => ({ hit: null, embedding: [0.1], lectureContentHash: 'h', lookupFailed: false }),
    writeAnswerMemory: async () => {},
  };

  try {
    // 1 & 2. FACT_QUESTION creates the expected root trace with only executed
    // stages. factDeps' memory-lookup mock returns a non-null embedding
    // (simulating a real miss, which always generates one) — the embedding
    // is correctly reused rather than generated a second time, so no
    // separate generate-query-embedding span is expected here.
    {
      const { trace } = await withTrace('OBSTEST DISTINCTIVE_QUESTION_TOKEN_XY9 fact question', factDeps, ctx);
      const names = spanNames(trace);
      const expected = ['load-session-history', 'classify-query-route', 'exact-memory-lookup', 'vector-search', 'rerank-candidates', 'generate-grounded-answer', 'save-chat-entry', 'write-answer-memory'];
      results['1'] = { pass: trace.rootName === 'ask-lecture-agent' && typeof trace.traceId === 'string' && trace.traceId.length > 0 && trace.status === 'SUCCESS', detail: `root="${trace.rootName}" status=${trace.status}` };
      results['2'] = { pass: JSON.stringify(names) === JSON.stringify(expected), detail: `spans=${JSON.stringify(names)}` };
    }

    // 2b. When memory lookup provides no embedding (e.g. an exact hit never
    // needed one), a fresh generate-query-embedding span DOES appear.
    {
      const { trace } = await withTrace('OBSTEST fresh embedding question', {
        ...factDeps,
        lookupAnswerMemory: async () => ({ hit: null, embedding: null, lectureContentHash: 'h', lookupFailed: false }),
      }, ctx);
      const names = spanNames(trace);
      results['2b'] = { pass: names.includes('generate-query-embedding'), detail: `spans=${JSON.stringify(names)}` };
    }

    // 3. GREETING creates no embedding/search/rerank/Gemini spans
    {
      const { trace } = await withTrace('Hello', { classifyRoute: async () => ({ route: 'GREETING', source: 'rule' }) }, ctx);
      const names = spanNames(trace);
      const forbidden = ['generate-query-embedding', 'vector-search', 'rerank-candidates', 'generate-grounded-answer', 'exact-memory-lookup'];
      results['3'] = { pass: forbidden.every(n => !names.includes(n)), detail: `spans=${JSON.stringify(names)}` };
    }

    // 4. LECTURE_SUMMARY creates summary-specific spans
    {
      const { trace } = await withTrace('Summarize this lecture.', {
        classifyRoute: async () => ({ route: 'LECTURE_SUMMARY', source: 'rule' }),
        getAllLectureChunks: async () => [fakeChunk(2, lectureId)],
        generateLectureSummary: async () => 'A fixture summary.',
      }, ctx);
      const names = spanNames(trace);
      results['4'] = { pass: names.includes('fetch-all-lecture-chunks') && names.includes('summarize-lecture-content'), detail: `spans=${JSON.stringify(names)}` };
    }

    // 5. CONTEXTUAL_FOLLOW_UP creates a rewrite span
    {
      const { trace } = await withTrace('Why is it necessary?', {
        ...factDeps,
        classifyRoute: async () => ({ route: 'CONTEXTUAL_FOLLOW_UP', source: 'rule' }),
        resolveRetrievalQuery: async () => ({ query: 'Why is X necessary?', wasRewritten: true, attempted: true }),
      }, ctx);
      const names = spanNames(trace);
      results['5'] = { pass: names.includes('rewrite-contextual-query') && !names.includes('exact-memory-lookup'), detail: `spans=${JSON.stringify(names)}` };
    }

    // 6. Exact-memory hit creates no embedding/search/rerank/generation spans
    {
      const { trace } = await withTrace('OBSTEST memory hit question', {
        classifyRoute: async () => ({ route: 'FACT_QUESTION', source: 'rule' }),
        lookupAnswerMemory: async () => ({
          hit: { matchType: 'EXACT', memoryId: 999, answer: 'cached answer', sourceChunkIds: [1], chunks: [fakeChunk(1, lectureId)] },
          embedding: null, lectureContentHash: 'h', lookupFailed: false,
        }),
        recordMemoryHit: async () => {},
      }, ctx);
      const names = spanNames(trace);
      const forbidden = ['generate-query-embedding', 'vector-search', 'rerank-candidates', 'generate-grounded-answer'];
      results['6'] = { pass: names.includes('exact-memory-lookup') && forbidden.every(n => !names.includes(n)), detail: `spans=${JSON.stringify(names)}` };
    }

    // 7. Observability failure (onTraceComplete throws) never fails the student request
    {
      const result = await askLectureAgent(
        { studentId, lectureId, question: 'OBSTEST observability failure question', sessionId: session.id },
        { ...factDeps, onTraceComplete: () => { throw new Error('simulated observability failure'); } }
      );
      results['7'] = { pass: result.answer === 'DISTINCTIVE_ANSWER_TOKEN_ZR7', detail: `answer="${result.answer}"` };
    }

    // 10. Sensitive content is not exported/captured by default
    {
      const secretQuestion = 'OBSTEST SECRET_QUESTION_TOKEN_998877';
      const { trace } = await withTrace(secretQuestion, factDeps, ctx);
      const serialized = JSON.stringify(trace);
      results['10'] = {
        pass: !serialized.includes('SECRET_QUESTION_TOKEN_998877') && !serialized.includes('DISTINCTIVE_ANSWER_TOKEN_ZR7'),
        detail: `question/answer text absent from trace: ${!serialized.includes('SECRET_QUESTION_TOKEN_998877')}`,
      };
    }

    // 11. Vector candidate counts and similarity summaries are recorded
    {
      const { trace } = await withTrace('OBSTEST candidate metadata question', {
        ...factDeps,
        searchChunks: async () => [fakeChunk(3, lectureId, { similarity: 0.81 }), fakeChunk(4, lectureId, { similarity: 0.62 })],
        rerankChunks: async (_q, c) => c.map(x => ({ ...x, rerankScore: 0.9 })),
      }, ctx);
      const vs = trace.spans.find(s => s.name === 'vector-search');
      results['11'] = {
        pass: vs?.metadata.candidateCount === 2 && vs?.metadata.topCosineSimilarity === 0.81 && vs?.metadata.lowestReturnedSimilarity === 0.62,
        detail: `metadata=${JSON.stringify(vs?.metadata)}`,
      };
    }

    // 12. Reranker input/output counts are recorded
    {
      const { trace } = await withTrace('OBSTEST reranker metadata question', {
        ...factDeps,
        searchChunks: async () => [fakeChunk(5, lectureId, { answer: 'Answer A' }), fakeChunk(6, lectureId, { answer: 'Answer B' })],
        rerankChunks: async (_q, c) => c.map(x => ({ ...x, rerankScore: 0.9 })),
      }, ctx);
      const rr = trace.spans.find(s => s.name === 'rerank-candidates');
      results['12'] = {
        pass: rr?.metadata.rerankerInputCount === 2 && rr?.metadata.rerankerOutputCount === 2 && rr?.metadata.rerankerModelVersion === 'bge-reranker-large',
        detail: `metadata=${JSON.stringify(rr?.metadata)}`,
      };
    }

    // 13. NO_VECTOR_CANDIDATES is recorded correctly
    {
      const { trace } = await withTrace('OBSTEST no candidates question', {
        ...factDeps,
        searchChunks: async () => [],
      }, ctx);
      results['13'] = { pass: trace.attributes.notFoundReason === 'NO_VECTOR_CANDIDATES', detail: `notFoundReason=${trace.attributes.notFoundReason}` };
    }

    // 14. ALL_CANDIDATES_BELOW_RERANK_FLOOR is recorded correctly
    {
      const { trace } = await withTrace('OBSTEST below floor question', {
        ...factDeps,
        searchChunks: async () => [fakeChunk(7, lectureId)],
        rerankChunks: async (_q, c) => c.map(x => ({ ...x, rerankScore: 0.1 })), // below the 0.5 floor
      }, ctx);
      results['14'] = { pass: trace.attributes.notFoundReason === 'ALL_CANDIDATES_BELOW_RERANK_FLOOR', detail: `notFoundReason=${trace.attributes.notFoundReason}` };
    }

    return results;
  } finally {
    await query(`DELETE FROM chat_history WHERE question LIKE 'OBSTEST%'`).catch(() => {});
    await deleteChatSession(studentId, session.id);
  }
}

// ── Part A: pure / no-DB ─────────────────────────────────────────────

cases.push({
  label: '8. Tracing disabled results in no Phoenix export attempt',
  run: async () => {
    // Must not depend on this developer's .env (which may set
    // OBSERVABILITY_ENABLED=true for local Phoenix testing). Force the
    // disabled state explicitly in an isolated child process — same
    // pattern as case 9 below — so this assertion is deterministic
    // regardless of the current process's already-loaded env/module cache.
    try {
      const out = execSync(
        `OBSERVABILITY_ENABLED=false PHOENIX_ENABLED=false "${TS_NODE_BIN}" --transpile-only -e "
          const { env } = require('./src/config/env');
          const { exportTraceToPhoenix } = require('./src/observability/phoenix');
          const start = Date.now();
          exportTraceToPhoenix({ traceId: 't1', rootSpanId: 'r1', rootName: 'ask-lecture-agent', startedAt: Date.now(), durationMs: 5, status: 'SUCCESS', attributes: {}, spans: [] }).then(() => {
            const elapsedMs = Date.now() - start;
            console.log('RESULT:' + JSON.stringify({ enabled: env.OBSERVABILITY.ENABLED, elapsedMs }));
          });
        "`,
        { cwd: path.join(__dirname, '..', '..'), timeout: 20000, encoding: 'utf8' }
      );
      const match = out.match(/RESULT:(\{.*\})/);
      if (!match) return { pass: false, detail: `no RESULT line in output: ${out.trim().slice(-200)}` };
      const { enabled, elapsedMs } = JSON.parse(match[1]);
      return { pass: enabled === false && elapsedMs < 50, detail: `OBSERVABILITY.ENABLED=${enabled}, elapsedMs=${elapsedMs}` };
    } catch (err) {
      return { pass: false, detail: `child process failed: ${(err as Error).message.slice(0, 200)}` };
    }
  },
});

cases.push({
  label: '9. Missing Phoenix configuration (PHOENIX_ENABLED=true, no PHOENIX_ENDPOINT) is safe',
  run: async () => {
    try {
      const out = execSync(
        `OBSERVABILITY_ENABLED=true PHOENIX_ENABLED=true PHOENIX_ENDPOINT= "${TS_NODE_BIN}" --transpile-only -e "
          require('./src/observability/phoenix').exportTraceToPhoenix({
            traceId: 't2', rootName: 'ask-lecture-agent', startedAt: Date.now(), durationMs: 1, status: 'SUCCESS', attributes: {}, spans: []
          }).then(() => console.log('SAFE_COMPLETION')).catch(e => console.log('THREW:' + e.message));
        "`,
        { cwd: path.join(__dirname, '..', '..'), timeout: 20000, encoding: 'utf8' }
      );
      return { pass: out.includes('SAFE_COMPLETION'), detail: out.trim().slice(-200) };
    } catch (err) {
      return { pass: false, detail: `child process failed: ${(err as Error).message.slice(0, 200)}` };
    }
  },
});

cases.push({
  label: '15. Gemini operation type and latency are recorded (no live call needed)',
  run: async () => {
    let loggedLine = '';
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { loggedLine += chunk; return true; }) as typeof process.stdout.write;
    try {
      await withGeminiDiagnostic(
        { spanName: 'gemini_rewriter_call', operationType: 'QUERY_REWRITE', model: 'gemini-2.5-flash' },
        async () => ({ response: { usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 34 } } })
      );
    } finally {
      process.stdout.write = originalWrite;
    }
    const pass = loggedLine.includes('op=QUERY_REWRITE') && loggedLine.includes('model=gemini-2.5-flash') && loggedLine.includes('success=true');
    return { pass, detail: loggedLine.trim().slice(0, 200) };
  },
});

cases.push({
  label: '16. Embedding vectors themselves are never included in span metadata',
  run: async () => {
    // Static check: the instrumentation call site only ever reads
    // vec.length, never the vector array itself, as metadata.
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'chat.service.ts'), 'utf8');
    const embedSpanBlock = src.slice(src.indexOf("'generate-query-embedding'"), src.indexOf("'generate-query-embedding'") + 400);
    const pass = embedSpanBlock.includes('vec.length') && !/questionEmbedding[,\s]/.test(embedSpanBlock.split('=>')[1] ?? '');
    return { pass, detail: pass ? 'metadata callback only reads vec.length' : 'could not confirm' };
  },
});

// ── Part B: health checks (real, against this environment) ─────────────

cases.push({
  label: '17. /health/live succeeds when the process is alive',
  run: async () => {
    const r = checkLiveness();
    return { pass: r.status === 'ok' && typeof r.timestamp === 'string', detail: JSON.stringify(r) };
  },
});

cases.push({
  label: '18/19/20. /health/ready reports structured per-component status (DB+pgvector healthy; embedding/reranker genuinely down in this environment -> unhealthy overall)',
  run: async () => {
    const r = await checkReadiness();
    const shapeOk = ['healthy', 'degraded', 'unhealthy'].includes(r.status)
      && typeof r.checkedAt === 'string'
      && r.components.database && r.components.pgvector && r.components.embeddingServer && r.components.reranker && r.components.gemini;
    const dbHealthy = r.components.database.status === 'healthy';
    const pgvectorHealthy = r.components.pgvector.status === 'healthy';
    // Required-dependency (embeddingServer) down in this environment ->
    // overall must be unhealthy per our documented semantics.
    const overallReflectsRequiredFailure = r.components.embeddingServer.status !== 'healthy' ? r.status === 'unhealthy' : true;
    const pass = shapeOk && dbHealthy && pgvectorHealthy && overallReflectsRequiredFailure;
    return { pass, detail: JSON.stringify({ status: r.status, components: Object.fromEntries(Object.entries(r.components).map(([k, v]) => [k, v.status])) }) };
  },
});

cases.push({
  label: '21. Gemini health checks use caching/TTL rather than calling on every request',
  run: async () => {
    const start1 = Date.now();
    await checkReadiness();
    const elapsed1 = Date.now() - start1;
    const start2 = Date.now();
    await checkReadiness();
    const elapsed2 = Date.now() - start2;
    // Second call should hit the cache for every component (all within TTL) -> much faster.
    const pass = elapsed2 < elapsed1 || elapsed2 < 20;
    return { pass, detail: `first=${elapsed1}ms, second=${elapsed2}ms` };
  },
});

cases.push({
  label: '22. Health responses do not expose raw provider errors — errorCode is always a short safe code',
  run: async () => {
    const r = await checkReadiness();
    const codes = Object.values(r.components).map(c => c.errorCode).filter((c): c is string => !!c);
    const pass = codes.every(c => /^[A-Z_]+$/.test(c) && c.length < 40);
    return { pass, detail: `errorCodes=${JSON.stringify(codes)}` };
  },
});

cases.push({
  label: '23. Existing /health behavior remains unchanged (route source untouched)',
  run: async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'index.ts'), 'utf8');
    const pass = src.includes(`router.get('/health', (_req, res) => {`) && src.includes(`res.json({ status: 'ok', timestamp: new Date().toISOString() });`);
    return { pass };
  },
});

cases.push({
  label: '45. generateAnswerFromLLM is never referenced by any observability file',
  run: async () => {
    const dir = path.join(__dirname, '..', 'observability');
    const offenders = fs.readdirSync(dir).filter(f =>
      fs.readFileSync(path.join(dir, f), 'utf8').includes('generateAnswerFromLLM')
    );
    return { pass: offenders.length === 0, detail: offenders.length ? `found in: ${offenders.join(', ')}` : 'not referenced' };
  },
});

// ── Runner ────────────────────────────────────────────────────────────

async function main() {
  let ran = 0, failures = 0, skipped = 0;

  for (const c of cases) {
    ran++;
    try {
      const r = await c.run();
      if (r.skip) { skipped++; console.log(`SKIP  ${c.label}${r.detail ? ` (${r.detail})` : ''}`); }
      else if (r.pass) { console.log(`PASS  ${c.label}${r.detail ? ` (${r.detail})` : ''}`); }
      else { failures++; console.log(`FAIL  ${c.label}${r.detail ? ` (${r.detail})` : ''}`); }
    } catch (err) {
      failures++;
      console.log(`FAIL  ${c.label} (threw: ${(err as Error).message})`);
    }
  }

  console.log('\n--- Tracing (real lecture, stubbed AI calls) ---');
  const labels: Record<string, string> = {
    '1': '1. A FACT_QUESTION creates the expected root trace',
    '2': '2. Only executed stages create child spans (embedding reused from memory lookup)',
    '2b': '2b. A fresh embedding span appears when memory lookup provides none',
    '3': '3. A GREETING does not create embedding/search/rerank/Gemini spans',
    '4': '4. A LECTURE_SUMMARY creates summary-specific spans',
    '5': '5. A CONTEXTUAL_FOLLOW_UP creates a rewrite span',
    '6': '6. Exact-memory hit does not create embedding/search/rerank/generation spans',
    '7': '7. Observability failure never fails the student request',
    '10': '10. Sensitive content is not exported by default',
    '11': '11. Vector candidate counts and similarity summaries are recorded',
    '12': '12. Reranker input/output counts are recorded',
    '13': '13. NO_VECTOR_CANDIDATES is recorded correctly',
    '14': '14. ALL_CANDIDATES_BELOW_RERANK_FLOOR is recorded correctly',
  };
  try {
    const results = await runTracingChecks();
    for (const key of Object.keys(labels)) {
      ran++;
      const r = results[key];
      if (!r) { failures++; console.log(`FAIL  ${labels[key]} (no result)`); continue; }
      if (r.skip) { skipped++; console.log(`SKIP  ${labels[key]}${r.detail ? ` (${r.detail})` : ''}`); }
      else if (r.pass) { console.log(`PASS  ${labels[key]}${r.detail ? ` (${r.detail})` : ''}`); }
      else { failures++; console.log(`FAIL  ${labels[key]}${r.detail ? ` (${r.detail})` : ''}`); }
    }
  } catch (err) {
    failures += Object.keys(labels).length;
    ran += Object.keys(labels).length;
    console.log(`FAIL  Tracing block (threw: ${(err as Error).message})`);
  }

  console.log(`\n${ran - skipped - failures}/${ran - skipped} passed${skipped ? ` (${skipped} skipped)` : ''}`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
