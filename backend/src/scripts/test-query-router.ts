/**
 * Validates the query router added in front of askLectureAgent
 * (query-router.service.ts, lecture-summary.service.ts) plus the two
 * improved "not found in lecture" fallback paths in chat.service.ts.
 *
 * Two tiers, like test-query-rewriter.ts:
 *  - Part A: pure/deterministic rule checks, a couple of live Gemini
 *    quality checks (route classification + summary grounding), and a
 *    static dead-code check — no DB required.
 *  - Part B: chat.service wiring, verified against a real lecture from the
 *    DB with the AI/network calls stubbed via askLectureAgent's deps seam.
 *
 * Usage: npm run test:query-router
 */
import * as fs from 'fs';
import * as path from 'path';
import { env } from '../config/env';
import { query } from '../config/database';
import { QnaChunk } from '../types';
import {
  classifyRoute,
  parseRouteResponse,
} from '../services/query-router.service';
import {
  generateLectureSummary,
  buildSummaryBatches,
  LECTURE_SUMMARY_UNAVAILABLE_MESSAGE,
} from '../services/lecture-summary.service';
import { resolveRetrievalQuery } from '../services/query-rewriter.service';
import {
  askLectureAgent,
  createChatSession,
  deleteChatSession,
  AskLectureAgentDeps,
  LECTURE_NOT_FOUND_MESSAGE,
} from '../services/chat.service';

if (!env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not configured.');
  process.exit(1);
}

interface CaseResult {
  pass: boolean;
  skip?: boolean;
  detail?: string;
}
interface Case {
  label: string;
  run: () => Promise<CaseResult>;
}

const cases: Case[] = [];

const fakeChunk = (id: number, overrides: Partial<QnaChunk> = {}): QnaChunk => ({
  id,
  lecture_id: 1,
  topic: 'Test',
  question: 'Q',
  answer: 'A',
  chunk_text: 'Q: Q\nA: A',
  start_time: null,
  end_time: null,
  keywords: null,
  ...overrides,
});

// ── Routing ─────────────────────────────────────────────────────────────

cases.push({
  label: '1. A normal lecture question routes to FACT_QUESTION',
  run: async () => {
    const r = await classifyRoute('What is OTP hashing?');
    return { pass: r.route === 'FACT_QUESTION' && r.source === 'rule', detail: `route=${r.route}, source=${r.source}` };
  },
});

cases.push({
  label: '2. "Summarize this lecture" routes to LECTURE_SUMMARY',
  run: async () => {
    const r = await classifyRoute('Summarize this lecture.');
    return { pass: r.route === 'LECTURE_SUMMARY' && r.source === 'rule', detail: `route=${r.route}, source=${r.source}` };
  },
});

cases.push({
  label: '3. "Give me the key points" routes to LECTURE_SUMMARY',
  run: async () => {
    const r = await classifyRoute('Give me the key points');
    return { pass: r.route === 'LECTURE_SUMMARY' && r.source === 'rule', detail: `route=${r.route}, source=${r.source}` };
  },
});

cases.push({
  label: '4. "Hello" routes to GREETING',
  run: async () => {
    const r = await classifyRoute('Hello');
    return { pass: r.route === 'GREETING' && r.source === 'rule', detail: `route=${r.route}, source=${r.source}` };
  },
});

cases.push({
  label: '5. A contextual pronoun follow-up ("Why is it necessary?") routes to CONTEXTUAL_FOLLOW_UP',
  run: async () => {
    const r = await classifyRoute('Why is it necessary?');
    return { pass: r.route === 'CONTEXTUAL_FOLLOW_UP' && r.source === 'rule', detail: `route=${r.route}, source=${r.source}` };
  },
});

cases.push({
  label: '6. A short clear question ("What is RAG?") routes to FACT_QUESTION',
  run: async () => {
    const r = await classifyRoute('What is RAG?');
    return { pass: r.route === 'FACT_QUESTION' && r.source === 'rule', detail: `route=${r.route}, source=${r.source}` };
  },
});

cases.push({
  label: '7. Invalid/unrecognized LLM router output parses to null (safe default)',
  run: async () => {
    const garbage = parseRouteResponse('not valid json{');
    const badEnum = parseRouteResponse(JSON.stringify({ route: 'BANANA' }));
    return { pass: garbage === null && badEnum === null };
  },
});

cases.push({
  label: '8. Router failure (forced timeout on an ambiguous message) does not fail the request — defaults to FACT_QUESTION',
  run: async () => {
    // No '?', no WH/imperative opener, not a greeting/summary/contextual
    // pattern — genuinely ambiguous, so classifyRoute reaches the LLM path.
    const ambiguous = 'the assignment deadline';
    const r = await classifyRoute(ambiguous, { timeoutMs: 1 });
    return { pass: r.route === 'FACT_QUESTION' && r.source === 'llm-fallback', detail: `route=${r.route}, source=${r.source}` };
  },
});

cases.push({
  label: '13. generateAnswerFromLLM (general-knowledge fallback) is never referenced by the router/chat/summary services',
  run: async () => {
    const servicesDir = path.join(__dirname, '..', 'services');
    const filesToCheck = ['chat.service.ts', 'query-router.service.ts', 'lecture-summary.service.ts', 'query-rewriter.service.ts'];
    const offenders = filesToCheck.filter(f =>
      fs.readFileSync(path.join(servicesDir, f), 'utf8').includes('generateAnswerFromLLM')
    );
    return { pass: offenders.length === 0, detail: offenders.length ? `found in: ${offenders.join(', ')}` : 'not referenced' };
  },
});

// ── Contextual follow-ups (rewriter behavior, exercised again here) ──────

cases.push({
  label: '14. A follow-up is rewritten using recent history',
  run: async () => {
    const history = [{ question: 'What is OTP hashing?', answer: 'OTP hashing converts the OTP into a hash before storing it.' }];
    const r = await resolveRetrievalQuery('Why is it necessary?', history);
    const pass = r.wasRewritten && r.query !== 'Why is it necessary?';
    return { pass, detail: `wasRewritten=${r.wasRewritten}, query="${r.query}"` };
  },
});

cases.push({
  label: '17. Rewriter failure (forced timeout) falls back to the original question',
  run: async () => {
    const history = [{ question: 'What is OTP hashing?', answer: 'OTP hashing converts the OTP into a hash before storing it.' }];
    const q = 'Why is it necessary?';
    const r = await resolveRetrievalQuery(q, history, { timeoutMs: 1 });
    return { pass: !r.wasRewritten && r.query === q, detail: `wasRewritten=${r.wasRewritten}` };
  },
});

cases.push({
  label: '18. An already self-contained question is not rewritten unnecessarily',
  run: async () => {
    const q = 'What is RAG?';
    const r = await resolveRetrievalQuery(q, [{ question: 'irrelevant', answer: 'irrelevant' }]);
    return { pass: !r.wasRewritten && r.query === q, detail: `wasRewritten=${r.wasRewritten}` };
  },
});

// ── Lecture summaries ──────────────────────────────────────────────────

cases.push({
  label: '21. Long content is split into multiple batches, and hierarchical summarization combines them (no network)',
  run: async () => {
    const chunks: QnaChunk[] = Array.from({ length: 6 }, (_, i) => fakeChunk(i, { chunk_text: 'X'.repeat(1000) }));
    const batches = buildSummaryBatches(chunks, 3000);
    const totalAcrossBatches = batches.reduce((sum, b) => sum + b.length, 0);

    let batchCalls = 0, combineCalls = 0;
    const summary = await generateLectureSummary(
      chunks,
      'Test Lecture',
      {
        summarizeBatch: async (batch) => { batchCalls++; return `partial-${batch.length}`; },
        combineSummaries: async (partials) => { combineCalls++; return `combined:${partials.length}`; },
      },
      { maxCharsPerBatch: 3000 }
    );

    const pass = batches.length > 1 && totalAcrossBatches === chunks.length
      && batchCalls === batches.length && combineCalls === 1 && summary === `combined:${batchCalls}`;
    return { pass, detail: `batches=${batches.length}, batchCalls=${batchCalls}, combineCalls=${combineCalls}, summary="${summary}"` };
  },
});

cases.push({
  label: '22. Summary generation stays grounded in the provided lecture content (live Gemini check)',
  run: async () => {
    const distinctive = fakeChunk(901, {
      topic: 'Zorvath Protocol',
      question: 'What is the Zorvath Protocol?',
      answer: 'The Zorvath Protocol is a fictional three-step handshake used only in this test: ping, echo, confirm.',
      chunk_text: 'Topic: Zorvath Protocol\nQ: What is the Zorvath Protocol?\nA: The Zorvath Protocol is a fictional three-step handshake used only in this test: ping, echo, confirm.',
    });
    const summary = await generateLectureSummary([distinctive], 'Test Lecture', {}, { timeoutMs: 15000 });
    const pass = !!summary && summary.toLowerCase().includes('zorvath');
    return { pass, detail: `summary="${summary?.slice(0, 160)}"` };
  },
});

cases.push({
  label: '23a. generateLectureSummary returns null for an empty chunk list (no network)',
  run: async () => ({ pass: (await generateLectureSummary([], 'Empty Lecture')) === null }),
});

// ── Part B: chat.service wiring against a real lecture ──────────────────

async function runIntegrationChecks(): Promise<Record<string, CaseResult>> {
  const { rows: lectureRows } = await query<{ id: number }>(`SELECT id FROM lectures WHERE status = 'READY' LIMIT 1`);
  const { rows: userRows } = await query<{ id: string }>(`SELECT id FROM users LIMIT 1`);

  const KEYS = ['9', '10', '11', '12a', '12b', '15', '16', '19', '20', '23', '24', '25'];
  if (lectureRows.length === 0 || userRows.length === 0) {
    const skip: CaseResult = { pass: false, skip: true, detail: 'SKIPPED — no READY lecture or user found in DB' };
    return Object.fromEntries(KEYS.map(k => [k, skip]));
  }

  const lectureId = lectureRows[0].id;
  const studentId = userRows[0].id;
  const session = await createChatSession(studentId, lectureId);
  const results: Record<string, CaseResult> = {};

  const lastStored = async (): Promise<{ question: string; answer: string } | undefined> => {
    const { rows } = await query<{ question: string; answer: string }>(
      `SELECT question, answer FROM chat_history WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [session.id]
    );
    return rows[0];
  };

  try {
    // 9. FACT_QUESTION continues using the existing pipeline with the ORIGINAL question
    {
      const embedCalls: string[] = [], rerankCalls: string[] = [], answerCalls: string[] = [];
      const deps: AskLectureAgentDeps = {
        classifyRoute: async () => ({ route: 'FACT_QUESTION', source: 'rule' }),
        generateEmbedding: async (t) => { embedCalls.push(t); return [0.1]; },
        searchChunks: async () => [fakeChunk(101, { lecture_id: lectureId })],
        rerankChunks: async (q, c) => { rerankCalls.push(q); return c.map(x => ({ ...x, rerankScore: 0.9 })); },
        generateAnswer: async (q) => { answerCalls.push(q); return 'Fact answer.'; },
      };
      const q = 'What is OTP hashing?';
      await askLectureAgent({ studentId, lectureId, question: q, sessionId: session.id }, deps);
      results['9'] = {
        pass: embedCalls[0] === q && rerankCalls[0] === q && answerCalls[0] === q,
        detail: `embed="${embedCalls[0]}", rerank="${rerankCalls[0]}", answer="${answerCalls[0]}"`,
      };
    }

    // 10 & 12a. Zero vector candidates → exact fallback, no Gemini, saved correctly
    {
      let answerCalled = 0;
      const deps: AskLectureAgentDeps = {
        classifyRoute: async () => ({ route: 'FACT_QUESTION', source: 'rule' }),
        generateEmbedding: async () => [0.1],
        searchChunks: async () => [],
        generateAnswer: async () => { answerCalled++; return 'should not be called'; },
      };
      const q = 'Zero-candidate router test question?';
      const result = await askLectureAgent({ studentId, lectureId, question: q, sessionId: session.id }, deps);
      const stored = await lastStored();
      results['10'] = { pass: result.answer === LECTURE_NOT_FOUND_MESSAGE && answerCalled === 0, detail: `answer="${result.answer}", generateAnswerCalls=${answerCalled}` };
      results['12a'] = { pass: stored?.answer === LECTURE_NOT_FOUND_MESSAGE && stored?.question === q, detail: `stored answer="${stored?.answer}"` };
    }

    // 11 & 12b. All candidates below the relevance floor → same fallback, no Gemini, saved correctly
    {
      let answerCalled = 0;
      const deps: AskLectureAgentDeps = {
        classifyRoute: async () => ({ route: 'FACT_QUESTION', source: 'rule' }),
        generateEmbedding: async () => [0.1],
        searchChunks: async () => [fakeChunk(102, { lecture_id: lectureId })],
        rerankChunks: async (_q, c) => c.map(x => ({ ...x, rerankScore: 0.1 })), // below the 0.5 floor
        generateAnswer: async () => { answerCalled++; return 'should not be called'; },
      };
      const q = 'Below-floor router test question?';
      const result = await askLectureAgent({ studentId, lectureId, question: q, sessionId: session.id }, deps);
      const stored = await lastStored();
      results['11'] = { pass: result.answer === LECTURE_NOT_FOUND_MESSAGE && answerCalled === 0, detail: `answer="${result.answer}", generateAnswerCalls=${answerCalled}` };
      results['12b'] = { pass: stored?.answer === LECTURE_NOT_FOUND_MESSAGE && stored?.question === q, detail: `stored answer="${stored?.answer}"` };
    }

    // 15 & 16. CONTEXTUAL_FOLLOW_UP: rewritten query for embed/rerank, original for answer + storage
    {
      const REWRITTEN = 'REWRITTEN_QUERY_FOR_ROUTER_TEST';
      const ORIGINAL = 'Why is it necessary?';
      const embedCalls: string[] = [], rerankCalls: string[] = [], answerCalls: string[] = [];
      const deps: AskLectureAgentDeps = {
        classifyRoute: async () => ({ route: 'CONTEXTUAL_FOLLOW_UP', source: 'rule' }),
        resolveRetrievalQuery: async () => ({ query: REWRITTEN, wasRewritten: true, attempted: true }),
        generateEmbedding: async (t) => { embedCalls.push(t); return [0.1]; },
        searchChunks: async () => [fakeChunk(103, { lecture_id: lectureId })],
        rerankChunks: async (q, c) => { rerankCalls.push(q); return c.map(x => ({ ...x, rerankScore: 0.9 })); },
        generateAnswer: async (q) => { answerCalls.push(q); return 'Follow-up answer.'; },
      };
      await askLectureAgent({ studentId, lectureId, question: ORIGINAL, sessionId: session.id }, deps);
      const stored = await lastStored();
      results['15'] = { pass: embedCalls[0] === REWRITTEN && rerankCalls[0] === REWRITTEN, detail: `embed="${embedCalls[0]}", rerank="${rerankCalls[0]}"` };
      results['16'] = { pass: answerCalls[0] === ORIGINAL && stored?.question === ORIGINAL, detail: `answerQ="${answerCalls[0]}", storedQ="${stored?.question}"` };
    }

    // 19 & 20. LECTURE_SUMMARY: no vector search, uses the complete selected lecture's content
    {
      const fixture = [fakeChunk(201, { lecture_id: lectureId }), fakeChunk(202, { lecture_id: lectureId }), fakeChunk(203, { lecture_id: lectureId })];
      let searchCalled = 0;
      let received: QnaChunk[] = [];
      const deps: AskLectureAgentDeps = {
        classifyRoute: async () => ({ route: 'LECTURE_SUMMARY', source: 'rule' }),
        searchChunks: async () => { searchCalled++; return []; },
        getAllLectureChunks: async () => fixture,
        generateLectureSummary: async (chunks) => { received = chunks; return 'A grounded summary.'; },
      };
      await askLectureAgent({ studentId, lectureId, question: 'Summarize this lecture.', sessionId: session.id }, deps);
      results['19'] = { pass: searchCalled === 0, detail: `searchChunks calls=${searchCalled}` };
      results['20'] = { pass: received.length === fixture.length, detail: `received ${received.length}/${fixture.length} chunks` };
    }

    // 23. Empty lecture content → clear lecture-specific fallback, summarizer never called
    {
      let summarizeCalled = 0;
      const deps: AskLectureAgentDeps = {
        classifyRoute: async () => ({ route: 'LECTURE_SUMMARY', source: 'rule' }),
        getAllLectureChunks: async () => [],
        generateLectureSummary: async () => { summarizeCalled++; return 'should not be called'; },
      };
      const result = await askLectureAgent({ studentId, lectureId, question: 'Summarize this lecture.', sessionId: session.id }, deps);
      results['23'] = {
        pass: result.answer === LECTURE_SUMMARY_UNAVAILABLE_MESSAGE && summarizeCalled === 0,
        detail: `answer="${result.answer}", summarizeCalls=${summarizeCalled}`,
      };
    }

    // 24 & 25. GREETING: no embed/search/rerank/full-lecture load; normal response contract
    {
      let embedCalled = 0, searchCalled = 0, rerankCalled = 0, allChunksCalled = 0;
      const deps: AskLectureAgentDeps = {
        classifyRoute: async () => ({ route: 'GREETING', source: 'rule' }),
        generateEmbedding: async () => { embedCalled++; return [0.1]; },
        searchChunks: async () => { searchCalled++; return []; },
        rerankChunks: async () => { rerankCalled++; return []; },
        getAllLectureChunks: async () => { allChunksCalled++; return []; },
      };
      const q = 'Hello';
      const result = await askLectureAgent({ studentId, lectureId, question: q, sessionId: session.id }, deps);
      const stored = await lastStored();
      results['24'] = {
        pass: embedCalled === 0 && searchCalled === 0 && rerankCalled === 0 && allChunksCalled === 0,
        detail: `embed=${embedCalled}, search=${searchCalled}, rerank=${rerankCalled}, fullLoad=${allChunksCalled}`,
      };
      results['25'] = {
        pass: typeof result.answer === 'string' && result.answer.length > 0
          && Array.isArray(result.sources) && result.sources.length === 0
          && stored?.question === q && stored?.answer === result.answer,
        detail: `answer="${result.answer}", sources=${JSON.stringify(result.sources)}`,
      };
    }

    return results;
  } finally {
    await deleteChatSession(studentId, session.id);
  }
}

// ── Runner ────────────────────────────────────────────────────────────

async function main() {
  let failures = 0;
  let skipped = 0;
  let ran = 0;

  for (const c of cases) {
    ran++;
    try {
      const result = await c.run();
      if (result.skip) { skipped++; console.log(`SKIP  ${c.label}${result.detail ? ` (${result.detail})` : ''}`); }
      else if (result.pass) { console.log(`PASS  ${c.label}${result.detail ? ` (${result.detail})` : ''}`); }
      else { failures++; console.log(`FAIL  ${c.label}${result.detail ? ` (${result.detail})` : ''}`); }
    } catch (err) {
      failures++; ran++;
      console.log(`FAIL  ${c.label} (threw: ${(err as Error).message})`);
    }
  }

  console.log('\n--- chat.service wiring (real lecture, stubbed AI calls) ---');
  const labels: Record<string, string> = {
    '9': '9. FACT_QUESTION uses embedding/vector-search/rerank pipeline with the original question',
    '10': '10. Zero vector candidates → exact fallback, no Gemini call',
    '11': '11. All candidates below relevance floor → exact fallback, no Gemini call',
    '12a': '12 (path 1). Fallback saved correctly',
    '12b': '12 (path 2). Fallback saved correctly',
    '15': '15. Rewritten query used for embedding and reranking',
    '16': '16. Original question used for chat storage and answer generation',
    '19': '19. Summary requests do not run vector similarity search',
    '20': '20. Summary requests use content from the complete selected lecture',
    '23': '23. Empty lecture content returns a clear fallback without general knowledge',
    '24': '24. Greetings skip embedding/search/rerank/full-lecture loading',
    '25': '25. Greeting responses are saved and returned using the normal response contract',
  };

  try {
    const results = await runIntegrationChecks();
    for (const key of Object.keys(labels)) {
      const r = results[key];
      ran++;
      if (!r) { failures++; console.log(`FAIL  ${labels[key]} (no result)`); continue; }
      if (r.skip) { skipped++; console.log(`SKIP  ${labels[key]}${r.detail ? ` (${r.detail})` : ''}`); }
      else if (r.pass) { console.log(`PASS  ${labels[key]}${r.detail ? ` (${r.detail})` : ''}`); }
      else { failures++; console.log(`FAIL  ${labels[key]}${r.detail ? ` (${r.detail})` : ''}`); }
    }
  } catch (err) {
    failures += Object.keys(labels).length;
    ran += Object.keys(labels).length;
    console.log(`FAIL  chat.service wiring block (threw: ${(err as Error).message})`);
  }

  console.log(`\n${ran - skipped - failures}/${ran - skipped} passed${skipped ? ` (${skipped} skipped)` : ''}`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
