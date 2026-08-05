/**
 * Validates the history-aware query-rewriting step added to askLectureAgent
 * (see query-rewriter.service.ts). Covers the rewriter's own detection,
 * parsing, and fallback logic directly — fast and deterministic, no live
 * services needed for most cases — plus two live Gemini rewrite-quality
 * checks and a chat.service wiring check against a real lecture from the DB
 * (embedding/rerank/answer-generation calls are stubbed via
 * askLectureAgent's deps seam, so no Python embedding/rerank server or
 * extra Gemini calls are needed for that part).
 *
 * Usage: npm run test:query-rewriter
 */
import { env } from '../config/env';
import { query } from '../config/database';
import {
  isContextDependent,
  parseRewriteResponse,
  resolveRetrievalQuery,
} from '../services/query-rewriter.service';
import {
  askLectureAgent,
  createChatSession,
  deleteChatSession,
  AskLectureAgentDeps,
} from '../services/chat.service';
import { QnaChunk } from '../types';

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

// 1. Contextual pronoun follow-up is rewritten correctly using history
cases.push({
  label: '1. Pronoun follow-up ("Why is it necessary?") is rewritten using history',
  run: async () => {
    const history = [{
      question: 'What is OTP hashing?',
      answer: 'OTP hashing converts the OTP into an irreversible hash before storing it in the database.',
    }];
    const result = await resolveRetrievalQuery('Why is it necessary?', history);
    const lower = result.query.toLowerCase();
    const pass = result.wasRewritten
      && result.query !== 'Why is it necessary?'
      && (lower.includes('otp') || lower.includes('hash'));
    return { pass, detail: `wasRewritten=${result.wasRewritten}, query="${result.query}"` };
  },
});

// 2. "Explain that again" is rewritten using recent history
cases.push({
  label: '2. "Explain that again." is rewritten using recent history',
  run: async () => {
    const history = [{
      question: 'What is vector search?',
      answer: 'Vector search retrieves the nearest-neighbor embeddings to a query using cosine similarity.',
    }];
    const result = await resolveRetrievalQuery('Explain that again.', history);
    const lower = result.query.toLowerCase();
    const pass = result.wasRewritten
      && result.query !== 'Explain that again.'
      && lower.includes('vector search');
    return { pass, detail: `wasRewritten=${result.wasRewritten}, query="${result.query}"` };
  },
});

// 3. A clear standalone question remains unchanged
cases.push({
  label: '3. Standalone question ("What are the advantages of using vector databases for search?") remains unchanged',
  run: async () => {
    const q = 'What are the advantages of using vector databases for search?';
    const history = [{ question: 'What is OTP hashing?', answer: 'OTP hashing converts the OTP into a hash before storing it.' }];
    const started = Date.now();
    const result = await resolveRetrievalQuery(q, history);
    const elapsedMs = Date.now() - started;
    const pass = !result.wasRewritten && result.query === q && elapsedMs < 200;
    return { pass, detail: `wasRewritten=${result.wasRewritten}, elapsedMs=${elapsedMs}` };
  },
});

// 4. A short but clear question is not rewritten unnecessarily
cases.push({
  label: '4. Short standalone question ("What is RAG?") is not rewritten',
  run: async () => {
    const q = 'What is RAG?';
    const detectedContextDependent = isContextDependent(q);
    const result = await resolveRetrievalQuery(q, [{ question: 'irrelevant', answer: 'irrelevant' }]);
    const pass = !detectedContextDependent && !result.wasRewritten && result.query === q;
    return { pass, detail: `isContextDependent=${detectedContextDependent}, wasRewritten=${result.wasRewritten}` };
  },
});

// 5. Rewriter failure (forced timeout) falls back to the original question
cases.push({
  label: '5. Forced timeout falls back to the original question',
  run: async () => {
    const history = [{ question: 'What is OTP hashing?', answer: 'OTP hashing converts the OTP into a hash before storing it.' }];
    const q = 'Why is it necessary?';
    const result = await resolveRetrievalQuery(q, history, { timeoutMs: 1 });
    const pass = !result.wasRewritten && result.query === q;
    return { pass, detail: `wasRewritten=${result.wasRewritten}, query="${result.query}"` };
  },
});

// 6. Invalid JSON falls back safely
cases.push({
  label: '6. Invalid JSON from the model parses to null (safe fallback)',
  run: async () => ({ pass: parseRewriteResponse('not valid json{') === null }),
});

// 7. Empty / whitespace-only rewritten query falls back safely
cases.push({
  label: '7. Empty/whitespace-only rewrittenQuery parses to null (safe fallback)',
  run: async () => {
    const empty = parseRewriteResponse(JSON.stringify({ rewrittenQuery: '', wasRewritten: true }));
    const whitespace = parseRewriteResponse(JSON.stringify({ rewrittenQuery: '   ', wasRewritten: true }));
    return { pass: empty === null && whitespace === null };
  },
});

// 10. No rewriting call occurs when the question is already self-contained
// (elapsed time is the observable proxy for "no network round-trip happened" —
// a real Gemini call takes hundreds of ms+, a skipped one returns near-instantly).
cases.push({
  label: '10. No rewrite call is made for a self-contained question',
  run: async () => {
    const q = 'List the main components of a RAG pipeline.';
    const started = Date.now();
    const result = await resolveRetrievalQuery(q, [{ question: 'irrelevant', answer: 'irrelevant' }]);
    const elapsedMs = Date.now() - started;
    const pass = !result.wasRewritten && elapsedMs < 200;
    return { pass, detail: `wasRewritten=${result.wasRewritten}, elapsedMs=${elapsedMs}` };
  },
});

// 8 & 9. chat.service wiring — verified together against a real lecture, with
// the AI/network calls stubbed via askLectureAgent's deps seam so this needs
// only a live Postgres connection, not the embedding/rerank/Gemini services.
async function runWiringCheck(): Promise<{ eight: CaseResult; nine: CaseResult }> {
  const { rows: lectureRows } = await query<{ id: number }>(`SELECT id FROM lectures WHERE status = 'READY' LIMIT 1`);
  const { rows: userRows } = await query<{ id: string }>(`SELECT id FROM users LIMIT 1`);

  if (lectureRows.length === 0 || userRows.length === 0) {
    const skip: CaseResult = { pass: false, skip: true, detail: 'SKIPPED — no READY lecture or no user found in DB' };
    return { eight: skip, nine: skip };
  }

  const lectureId = lectureRows[0].id;
  const studentId = userRows[0].id;
  const session = await createChatSession(studentId, lectureId);

  try {
    const REWRITTEN_QUERY = 'REWRITTEN_RETRIEVAL_QUERY_FOR_TEST';
    const ORIGINAL_QUESTION = 'Why is it necessary?';

    const embeddingCalls: string[] = [];
    const rerankCalls: string[] = [];
    const answerCalls: string[] = [];

    const fakeChunk: QnaChunk = {
      id: -1,
      lecture_id: lectureId,
      topic: 'Test',
      question: 'Q',
      answer: 'A',
      chunk_text: 'Q: Q\nA: A',
      start_time: null,
      end_time: null,
      keywords: null,
      similarity: 0.9,
    };

    const deps: AskLectureAgentDeps = {
      resolveRetrievalQuery: async () => ({ query: REWRITTEN_QUERY, wasRewritten: true, attempted: true }),
      generateEmbedding: async (text) => {
        embeddingCalls.push(text);
        return [0.1, 0.2, 0.3];
      },
      searchChunks: async () => [fakeChunk],
      rerankChunks: async (q, candidates) => {
        rerankCalls.push(q);
        return candidates.map(c => ({ ...c, rerankScore: 0.9 }));
      },
      generateAnswer: async (q) => {
        answerCalls.push(q);
        return 'Test answer.';
      },
    };

    await askLectureAgent({ studentId, lectureId, question: ORIGINAL_QUESTION, sessionId: session.id }, deps);

    const eight: CaseResult = {
      pass: embeddingCalls[0] === REWRITTEN_QUERY && rerankCalls[0] === REWRITTEN_QUERY,
      detail: `embedding called with="${embeddingCalls[0]}", rerank called with="${rerankCalls[0]}"`,
    };

    const { rows: storedRows } = await query<{ question: string }>(
      `SELECT question FROM chat_history WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [session.id]
    );

    const nine: CaseResult = {
      pass: answerCalls[0] === ORIGINAL_QUESTION && storedRows[0]?.question === ORIGINAL_QUESTION,
      detail: `generateAnswer called with="${answerCalls[0]}", stored chat_history.question="${storedRows[0]?.question}"`,
    };

    return { eight, nine };
  } finally {
    await deleteChatSession(studentId, session.id);
  }
}

async function main() {
  let failures = 0;
  let skipped = 0;

  for (const c of cases) {
    try {
      const result = await c.run();
      if (result.skip) {
        skipped++;
        console.log(`SKIP  ${c.label}${result.detail ? ` (${result.detail})` : ''}`);
      } else if (result.pass) {
        console.log(`PASS  ${c.label}${result.detail ? ` (${result.detail})` : ''}`);
      } else {
        failures++;
        console.log(`FAIL  ${c.label}${result.detail ? ` (${result.detail})` : ''}`);
      }
    } catch (err) {
      failures++;
      console.log(`FAIL  ${c.label} (threw: ${(err as Error).message})`);
    }
  }

  console.log('\n8. Rewritten query is used for embedding and reranking');
  console.log('9. Original question is still used for final answer generation and chat storage');
  try {
    const { eight, nine } = await runWiringCheck();
    for (const [label, result] of [['8', eight], ['9', nine]] as const) {
      if (result.skip) {
        skipped++;
        console.log(`SKIP  ${label}. ${result.detail}`);
      } else if (result.pass) {
        console.log(`PASS  ${label}. ${result.detail}`);
      } else {
        failures++;
        console.log(`FAIL  ${label}. ${result.detail}`);
      }
    }
  } catch (err) {
    failures += 2;
    console.log(`FAIL  8/9. (threw: ${(err as Error).message})`);
  }

  console.log(`\n${cases.length + 2 - skipped - failures}/${cases.length + 2 - skipped} passed${skipped ? ` (${skipped} skipped)` : ''}`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
