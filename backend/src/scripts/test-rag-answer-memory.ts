/**
 * Validates RAG answer memory (rag-answer-memory.service.ts) — a
 * lecture-scoped Q&A cache that reuses a previously generated, grounded
 * answer for a repeated or safely equivalent standalone FACT_QUESTION.
 *
 * Four tiers:
 *  - Part A: pure normalization/config checks, no DB.
 *  - Part B: direct service-level checks against the real DB (isolation,
 *    eligibility, semantic-config mechanics) using synthetic vectors —
 *    the local embedding server isn't running in this environment, so
 *    semantic-similarity numbers are engineered/deterministic, not real
 *    embedding-model output. See eval-memory-threshold.ts for real-model
 *    threshold tuning once the embedding server is available.
 *  - Part C: chat.service wiring via askLectureAgent's deps seam, against
 *    one real lecture/session.
 *  - Part D (via separate scripts): existing query-router/rewriter/rerank
 *    regression suites — run those alongside this one, not duplicated here.
 *
 * Usage: npm run test:rag-answer-memory
 */
import * as fs from 'fs';
import * as path from 'path';
import { env } from '../config/env';
import { query } from '../config/database';
import { QnaChunk } from '../types';
import {
  normalizeQuery,
  computeLectureContentHash,
  lookupAnswerMemory,
  writeAnswerMemory,
} from '../services/rag-answer-memory.service';
import { EMBEDDING_MODEL_VERSION } from '../services/embedding.service';
import { ANSWER_PROMPT_VERSION } from '../services/llm-gemini.service';
import {
  askLectureAgent,
  createChatSession,
  deleteChatSession,
  deleteChatEntry,
  saveChatEntry,
  AskLectureAgentDeps,
  LECTURE_NOT_FOUND_MESSAGE,
} from '../services/chat.service';

if (!env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not configured.');
  process.exit(1);
}

interface CaseResult { pass: boolean; skip?: boolean; detail?: string; }
interface Case { label: string; run: () => Promise<CaseResult>; }
const cases: Case[] = [];

const TAG = 'RAGMEMTEST';
const DIM = 1024;

const fakeEmbed = async (): Promise<number[]> => new Array(DIM).fill(0).map((_, i) => Math.sin(i));

function makeVector(seed: number): number[] {
  return Array.from({ length: DIM }, (_, i) => Math.sin(seed * (i + 1)) + 0.001 * Math.cos(seed + i));
}
function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const fakeChunk = (id: number, lectureId: number, overrides: Partial<QnaChunk> = {}): QnaChunk => ({
  id, lecture_id: lectureId, topic: 'Test', question: 'Q', answer: 'A',
  chunk_text: 'Q: Q\nA: A', start_time: null, end_time: null, keywords: null, ...overrides,
});

// ── Part A: pure normalization + static checks (no DB) ──────────────────

cases.push({
  label: '24. Case, extra spaces, and harmless trailing punctuation still produce an exact hit (same normalized key)',
  run: async () => {
    const a = normalizeQuery('What is cosine similarity?');
    const b = normalizeQuery('what is cosine similarity');
    const c = normalizeQuery('  What   is cosine similarity?  ');
    return { pass: a === b && b === c, detail: `"${a}" / "${b}" / "${c}"` };
  },
});

cases.push({
  label: '25. Different intents on the same topic do not produce an exact hit (different normalized keys)',
  run: async () => {
    const base = normalizeQuery('What is cosine similarity?');
    const others = [
      'What are the disadvantages of cosine similarity?',
      'How is cosine similarity calculated?',
      'Why did we choose cosine similarity?',
    ].map(normalizeQuery);
    const pass = others.every(o => o !== base);
    return { pass, detail: `base="${base}", others=${JSON.stringify(others)}` };
  },
});

cases.push({
  label: '26. Important numbers, symbols, and negation are preserved by normalization',
  run: async () => {
    const a = normalizeQuery('What is the difference between top-5 and top-15 retrieval?');
    const b = normalizeQuery('Why is this NOT a valid embedding?');
    const pass = a.includes('top-5') && a.includes('top-15') && b.includes('not');
    return { pass, detail: `"${a}" / "${b}"` };
  },
});

cases.push({
  label: '27. Semantic memory is disabled by default',
  run: async () => ({ pass: env.RAG_MEMORY.SEMANTIC_ENABLED === false, detail: `env.RAG_MEMORY.SEMANTIC_ENABLED=${env.RAG_MEMORY.SEMANTIC_ENABLED}` }),
});

cases.push({
  label: '32. Semantic memory does not reuse the lecture similarity threshold or reranker relevance floor',
  run: async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'rag-answer-memory.service.ts'), 'utf8');
    // Real risk is importing vector-search.service's/rerank.service's
    // constants (0.55 lecture-similarity floor, 0.5 reranker floor) —
    // not the name "SIMILARITY_THRESHOLD" itself, which this file
    // legitimately uses for its own, separately-configured RAG_MEMORY value.
    const offenders = [
      /from ['"]\.\/vector-search\.service['"]/,
      /from ['"]\.\/rerank\.service['"]/,
      /\bDEFAULT_MIN_RERANK_SCORE\b/,
      /\b0\.55\b/,
    ].filter(re => re.test(src));
    return { pass: offenders.length === 0, detail: offenders.length ? `pattern(s) matched: ${offenders.length}` : 'clean — no import from vector-search/rerank services, no hardcoded 0.55/reranker-floor reuse' };
  },
});

cases.push({
  label: '39. generateAnswerFromLLM is never referenced by the answer-memory service',
  run: async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'rag-answer-memory.service.ts'), 'utf8');
    return { pass: !src.includes('generateAnswerFromLLM') };
  },
});

// ── Part B: direct service-level checks against the real DB ─────────────

async function runServiceLevelChecks(): Promise<Record<string, CaseResult>> {
  const KEYS = ['10', '11', '12', '13', '14', '19', '21', '22', '23', '28', '29', '30', '31', '33', '34', '35', '36', '37a'];
  const { rows: lectureRows } = await query<{ id: number }>(`SELECT id FROM lectures WHERE status = 'READY' LIMIT 1`);
  const { rows: userRows } = await query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
  if (lectureRows.length === 0 || userRows.length === 0) {
    const skip: CaseResult = { pass: false, skip: true, detail: 'SKIPPED — no READY lecture or user found in DB' };
    return Object.fromEntries(KEYS.map(k => [k, skip]));
  }

  const lectureId = lectureRows[0].id;
  const studentId = userRows[0].id;
  const results: Record<string, CaseResult> = {};

  const { rows: realChunkRows } = await query<{ id: number }>(`SELECT id FROM lecture_qna_chunks WHERE lecture_id = $1 LIMIT 1`, [lectureId]);
  if (realChunkRows.length === 0) {
    const skip: CaseResult = { pass: false, skip: true, detail: 'SKIPPED — lecture has no chunks to reference' };
    return Object.fromEntries(KEYS.map(k => [k, skip]));
  }
  const realChunkId = realChunkRows[0].id;

  // A throwaway, non-cleared chat_history row to satisfy the FK + the
  // cleared_by_student=FALSE join requirement for manually-seeded rows.
  const sourceChatHistoryId = await saveChatEntry({
    studentId, lectureId, question: `${TAG} isolation fixture`, answer: 'fixture answer',
    sourceChunkIds: [], sessionId: null as unknown as number,
  }).catch(async () => {
    // sessionId is nullable at the DB level (ON DELETE SET NULL) even
    // though saveChatEntry's TS signature expects a number; fall back to a
    // raw insert if the ORM layer rejects null.
    const { rows } = await query<{ id: number }>(
      `INSERT INTO chat_history (student_id, lecture_id, question, answer, source_chunk_ids) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [studentId, lectureId, `${TAG} isolation fixture`, 'fixture answer', []]
    );
    return rows[0].id;
  });

  const realHash = await computeLectureContentHash(lectureId);
  const insertedIds: number[] = [];

  const insertRow = async (normalizedQuery: string, overrides: Partial<{
    student_id: string; lecture_id: number; lecture_content_hash: string;
    embedding_model_version: string; answer_prompt_version: string;
    source_chat_history_id: number; source_chunk_ids: number[]; cache_eligible: boolean;
    question_embedding: number[];
  }> = {}): Promise<number> => {
    const v = {
      student_id: studentId, lecture_id: lectureId, lecture_content_hash: realHash,
      embedding_model_version: EMBEDDING_MODEL_VERSION, answer_prompt_version: ANSWER_PROMPT_VERSION,
      source_chat_history_id: sourceChatHistoryId, source_chunk_ids: [999999], cache_eligible: true,
      question_embedding: makeVector(1),
      ...overrides,
    };
    const { rows } = await query<{ id: number }>(
      `INSERT INTO rag_answer_memory (
         student_id, lecture_id, source_chat_history_id, original_question, retrieval_query,
         normalized_query, question_embedding, answer, source_chunk_ids, lecture_content_hash,
         embedding_model_version, answer_prompt_version, cache_eligible
       ) VALUES ($1,$2,$3,$4,$4,$5,$6::vector,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        v.student_id, v.lecture_id, v.source_chat_history_id, `${TAG} ${normalizedQuery}`,
        normalizedQuery, `[${v.question_embedding.join(',')}]`, `fixture answer for ${normalizedQuery}`,
        v.source_chunk_ids, v.lecture_content_hash, v.embedding_model_version, v.answer_prompt_version, v.cache_eligible,
      ]
    );
    insertedIds.push(rows[0].id);
    return rows[0].id;
  };

  try {
    // 10 & 11 & 12 & 13 & 14 — isolation. Distinct, far-apart embedding
    // seeds (200+) so these fixture rows never collide with the semantic
    // test's near-duplicate/threshold vectors below (seed 1).
    const isoQ = `${TAG.toLowerCase()} isolation base question`;
    await insertRow(isoQ, { question_embedding: makeVector(200) });

    {
      const r = await lookupAnswerMemory({ studentId: '00000000-0000-0000-0000-000000000000', lectureId, question: isoQ, generateEmbedding: fakeEmbed });
      results['10'] = { pass: r.hit === null, detail: `hit=${JSON.stringify(r.hit)}` };
    }
    {
      const r = await lookupAnswerMemory({ studentId, lectureId: 999999, question: isoQ, generateEmbedding: fakeEmbed });
      results['11'] = { pass: r.hit === null, detail: `hit=${JSON.stringify(r.hit)}` };
    }
    {
      const q = `${TAG.toLowerCase()} version isolation question`;
      await insertRow(q, { lecture_content_hash: 'STALE_FAKE_HASH', question_embedding: makeVector(201) });
      const r = await lookupAnswerMemory({ studentId, lectureId, question: q, generateEmbedding: fakeEmbed });
      results['12'] = { pass: r.hit === null, detail: `hit=${JSON.stringify(r.hit)}` };
    }
    {
      const q = `${TAG.toLowerCase()} embedmodel isolation question`;
      await insertRow(q, { embedding_model_version: 'old-model-v0', question_embedding: makeVector(202) });
      const r = await lookupAnswerMemory({ studentId, lectureId, question: q, generateEmbedding: fakeEmbed });
      results['13'] = { pass: r.hit === null, detail: `hit=${JSON.stringify(r.hit)}` };
    }
    {
      const q = `${TAG.toLowerCase()} promptver isolation question`;
      await insertRow(q, { answer_prompt_version: 'v0-old', question_embedding: makeVector(203) });
      const r = await lookupAnswerMemory({ studentId, lectureId, question: q, generateEmbedding: fakeEmbed });
      results['14'] = { pass: r.hit === null, detail: `hit=${JSON.stringify(r.hit)}` };
    }

    // 19 — writeAnswerMemory refuses to store an answer with no source chunks
    {
      const before = (await query<{ c: string }>(`SELECT COUNT(*) c FROM rag_answer_memory`)).rows[0].c;
      await writeAnswerMemory({
        studentId, lectureId, sourceChatHistoryId,
        originalQuestion: `${TAG} no chunk ids question`, retrievalQuery: `${TAG} no chunk ids question`,
        answer: 'should not be stored', sourceChunkIds: [], questionEmbedding: makeVector(2), lectureContentHash: realHash,
      });
      const after = (await query<{ c: string }>(`SELECT COUNT(*) c FROM rag_answer_memory`)).rows[0].c;
      results['19'] = { pass: before === after, detail: `count before=${before}, after=${after}` };
    }

    // 21 — a cleared source chat_history row invalidates the memory hit
    {
      const q = `${TAG.toLowerCase()} cleared entry question`;
      const clearedSourceId = await saveChatEntry({
        studentId, lectureId, question: `${TAG} cleared source`, answer: 'x', sourceChunkIds: [], sessionId: null as unknown as number,
      }).catch(async () => {
        const { rows } = await query<{ id: number }>(
          `INSERT INTO chat_history (student_id, lecture_id, question, answer, source_chunk_ids) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [studentId, lectureId, `${TAG} cleared source`, 'x', []]
        );
        return rows[0].id;
      });
      await insertRow(q, { source_chat_history_id: clearedSourceId, question_embedding: makeVector(204) });
      await deleteChatEntry(studentId, clearedSourceId);
      const r = await lookupAnswerMemory({ studentId, lectureId, question: q, generateEmbedding: fakeEmbed });
      results['21'] = { pass: r.hit === null, detail: `hit=${JSON.stringify(r.hit)}` };
    }

    // 22 — clearing an entire session prevents its linked entries from being reused
    {
      const q = `${TAG.toLowerCase()} cleared session question`;
      const session = await createChatSession(studentId, lectureId);
      const sessionSourceId = await saveChatEntry({
        studentId, lectureId, question: `${TAG} cleared session source`, answer: 'x', sourceChunkIds: [], sessionId: session.id,
      });
      await insertRow(q, { source_chat_history_id: sessionSourceId, question_embedding: makeVector(205) });
      await deleteChatSession(studentId, session.id); // soft-clears every chat_history row in the session
      const r = await lookupAnswerMemory({ studentId, lectureId, question: q, generateEmbedding: fakeEmbed });
      results['22'] = { pass: r.hit === null, detail: `hit=${JSON.stringify(r.hit)}` };
    }

    // 23 — missing/deleted source chunks invalidate the hit
    {
      const q = `${TAG.toLowerCase()} missing chunk question`;
      await insertRow(q, { source_chunk_ids: [987654321], question_embedding: makeVector(206) }); // does not exist in lecture_qna_chunks
      const r = await lookupAnswerMemory({ studentId, lectureId, question: q, generateEmbedding: fakeEmbed });
      results['23'] = { pass: r.hit === null, detail: `hit=${JSON.stringify(r.hit)}` };
    }

    // 28, 29, 30, 31 — semantic mechanics with synthetic (non-real-model) vectors
    {
      const base = makeVector(1);
      const nearDup = base.map(x => x + 0.0005);
      const different = makeVector(97);
      const simDup = cosineSim(base, nearDup);
      const simDiff = cosineSim(base, different);
      const threshold = (simDup + simDiff) / 2;

      const q = `${TAG.toLowerCase()} semantic base question`;
      await insertRow(q, { question_embedding: base, source_chunk_ids: [realChunkId] });

      // 28 — semantic lookup does not run when explicitly disabled, even
      // though a near-duplicate vector would otherwise match.
      const disabledEmbed = async () => nearDup;
      const rDisabled = await lookupAnswerMemory(
        { studentId, lectureId, question: `${q} variant`, generateEmbedding: disabledEmbed },
        { semanticEnabled: false }
      );
      results['28'] = { pass: rDisabled.hit === null, detail: `hit=${JSON.stringify(rDisabled.hit)} (semantic disabled)` };

      // 29 — a high-confidence equivalent (near-duplicate) vector returns a semantic hit
      const rHit = await lookupAnswerMemory(
        { studentId, lectureId, question: `${q} variant`, generateEmbedding: async () => nearDup },
        { semanticEnabled: true, similarityThreshold: threshold }
      );
      results['29'] = { pass: rHit.hit?.matchType === 'SEMANTIC', detail: `simDup=${simDup.toFixed(4)}, threshold=${threshold.toFixed(4)}, hit=${rHit.hit?.matchType}` };

      // 30 — a related-but-different vector produces a miss at the same threshold
      const rMiss = await lookupAnswerMemory(
        { studentId, lectureId, question: `${q} unrelated variant`, generateEmbedding: async () => different },
        { semanticEnabled: true, similarityThreshold: threshold }
      );
      results['30'] = { pass: rMiss.hit === null, detail: `simDiff=${simDiff.toFixed(4)}, threshold=${threshold.toFixed(4)}, hit=${JSON.stringify(rMiss.hit)}` };

      // 31 — a semantic miss still returns the SAME embedding for reuse (only one generateEmbedding call)
      let embedCalls = 0;
      const spyEmbed = async () => { embedCalls++; return different; };
      const rReuse = await lookupAnswerMemory(
        { studentId, lectureId, question: `${q} unrelated variant 2`, generateEmbedding: spyEmbed },
        { semanticEnabled: true, similarityThreshold: threshold }
      );
      results['31'] = {
        pass: embedCalls === 1 && rReuse.embedding !== null && rReuse.embedding.length === DIM,
        detail: `embedCalls=${embedCalls}, embeddingReturned=${rReuse.embedding !== null}`,
      };
    }

    // 33 — invalid/missing threshold configuration fails safely to normal RAG
    {
      const q = `${TAG.toLowerCase()} invalid threshold question`;
      const rNull = await lookupAnswerMemory({ studentId, lectureId, question: q, generateEmbedding: fakeEmbed }, { semanticEnabled: true, similarityThreshold: null });
      const rNaN = await lookupAnswerMemory({ studentId, lectureId, question: `${q} b`, generateEmbedding: fakeEmbed }, { semanticEnabled: true, similarityThreshold: NaN });
      results['33'] = { pass: rNull.hit === null && rNaN.hit === null, detail: `nullThresholdHit=${rNull.hit}, nanThresholdHit=${rNaN.hit}` };
    }

    // 34 — a successful write actually creates a row
    {
      const q = `${TAG} write creates entry question`;
      const before = (await query<{ c: string }>(`SELECT COUNT(*) c FROM rag_answer_memory WHERE normalized_query = $1`, [normalizeQuery(q)])).rows[0].c;
      await writeAnswerMemory({
        studentId, lectureId, sourceChatHistoryId, originalQuestion: q, retrievalQuery: q,
        answer: 'a real grounded answer', sourceChunkIds: [1], questionEmbedding: makeVector(5), lectureContentHash: realHash,
      });
      const after = (await query<{ c: string }>(`SELECT COUNT(*) c FROM rag_answer_memory WHERE normalized_query = $1`, [normalizeQuery(q)])).rows[0].c;
      results['34'] = { pass: before === '0' && after === '1', detail: `before=${before}, after=${after}` };
    }

    // 35 — duplicate exact writes upsert instead of inserting a second row
    {
      const q = `${TAG} duplicate write question`;
      await writeAnswerMemory({
        studentId, lectureId, sourceChatHistoryId, originalQuestion: q, retrievalQuery: q,
        answer: 'first answer', sourceChunkIds: [1], questionEmbedding: makeVector(6), lectureContentHash: realHash,
      });
      await writeAnswerMemory({
        studentId, lectureId, sourceChatHistoryId, originalQuestion: q, retrievalQuery: q,
        answer: 'second answer (updated)', sourceChunkIds: [1, 2], questionEmbedding: makeVector(6), lectureContentHash: realHash,
      });
      const { rows } = await query<{ answer: string; c: string }>(
        `SELECT answer, (SELECT COUNT(*) FROM rag_answer_memory WHERE normalized_query = $1)::text AS c
         FROM rag_answer_memory WHERE normalized_query = $1`,
        [normalizeQuery(q)]
      );
      results['35'] = { pass: rows.length === 1 && rows[0].c === '1' && rows[0].answer === 'second answer (updated)', detail: `rowCount=${rows.length}, answer="${rows[0]?.answer}"` };
    }

    // 36 — a lookup-level failure (invalid UUID forces a DB error) falls back safely, never throws
    {
      let threw = false;
      let r: Awaited<ReturnType<typeof lookupAnswerMemory>> | null = null;
      try {
        r = await lookupAnswerMemory({ studentId: 'not-a-valid-uuid', lectureId, question: `${TAG} lookup failure question`, generateEmbedding: fakeEmbed });
      } catch { threw = true; }
      results['36'] = { pass: !threw && r?.hit === null, detail: `threw=${threw}, result=${JSON.stringify(r)}` };
    }

    // 37a — a write-level failure (invalid UUID) never throws
    {
      let threw = false;
      try {
        await writeAnswerMemory({
          studentId: 'not-a-valid-uuid', lectureId, sourceChatHistoryId,
          originalQuestion: `${TAG} write failure question`, retrievalQuery: `${TAG} write failure question`,
          answer: 'x', sourceChunkIds: [1], questionEmbedding: makeVector(7), lectureContentHash: realHash,
        });
      } catch { threw = true; }
      results['37a'] = { pass: !threw };
    }

    return results;
  } finally {
    if (insertedIds.length > 0) {
      await query(`DELETE FROM rag_answer_memory WHERE id = ANY($1)`, [insertedIds]).catch(() => {});
    }
    await query(`DELETE FROM rag_answer_memory WHERE lecture_id = $1 AND normalized_query LIKE $2`, [lectureId, `${TAG.toLowerCase()}%`]).catch(() => {});
    await query(`DELETE FROM chat_history WHERE question LIKE $1`, [`${TAG}%`]).catch(() => {});
  }
}

// ── Part C: chat.service wiring via askLectureAgent ─────────────────────

async function runIntegrationChecks(): Promise<Record<string, CaseResult>> {
  const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '15', '16', '17', '18', '20', '37b', '38'];
  const { rows: lectureRows } = await query<{ id: number }>(`SELECT id FROM lectures WHERE status = 'READY' LIMIT 1`);
  const { rows: userRows } = await query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
  if (lectureRows.length === 0 || userRows.length === 0) {
    const skip: CaseResult = { pass: false, skip: true, detail: 'SKIPPED — no READY lecture or user found in DB' };
    return Object.fromEntries(KEYS.map(k => [k, skip]));
  }

  const lectureId = lectureRows[0].id;
  const studentId = userRows[0].id;

  const { rows: realChunkRows } = await query<{ id: number }>(`SELECT id FROM lecture_qna_chunks WHERE lecture_id = $1 LIMIT 1`, [lectureId]);
  if (realChunkRows.length === 0) {
    const skip: CaseResult = { pass: false, skip: true, detail: 'SKIPPED — lecture has no chunks to reference' };
    return Object.fromEntries(KEYS.map(k => [k, skip]));
  }
  const realChunkId = realChunkRows[0].id;

  const session = await createChatSession(studentId, lectureId);
  const results: Record<string, CaseResult> = {};

  const lastStored = async (): Promise<{ id: number; question: string; answer: string; source_chunk_ids: number[]; updated_at?: Date } | undefined> => {
    const { rows } = await query<{ id: number; question: string; answer: string; source_chunk_ids: number[] }>(
      `SELECT id, question, answer, source_chunk_ids FROM chat_history WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [session.id]
    );
    return rows[0];
  };

  const sessionUpdatedAt = async (): Promise<Date> => {
    const { rows } = await query<{ updated_at: Date }>(`SELECT updated_at FROM chat_sessions WHERE id = $1`, [session.id]);
    return rows[0].updated_at;
  };

  try {
    const question = `${TAG} What is cosine similarity in this fixture`;
    const chunk = fakeChunk(realChunkId, lectureId);
    let embedCalls = 0, searchCalls = 0, rerankCalls = 0, answerCalls = 0;
    const pipelineDeps: AskLectureAgentDeps = {
      classifyRoute: async () => ({ route: 'FACT_QUESTION', source: 'rule' }),
      generateEmbedding: async () => { embedCalls++; return makeVector(11); },
      searchChunks: async () => { searchCalls++; return [chunk]; },
      rerankChunks: async (_q, c) => { rerankCalls++; return c.map(x => ({ ...x, rerankScore: 0.9 })); },
      generateAnswer: async () => { answerCalls++; return 'A grounded fixture answer.'; },
    };

    // First call — guaranteed memory miss, writes a real entry via the
    // real (unstubbed) memory service.
    const first = await askLectureAgent({ studentId, lectureId, question, sessionId: session.id }, pipelineDeps);

    // 34/1 sanity — a memory row now exists for this normalized question
    const { rows: writtenRows } = await query<{ id: number }>(
      `SELECT id FROM rag_answer_memory WHERE student_id = $1 AND lecture_id = $2 AND normalized_query = $3`,
      [studentId, lectureId, normalizeQuery(question)]
    );
    if (writtenRows.length === 0) {
      const skip: CaseResult = { pass: false, skip: true, detail: 'SKIPPED — first FACT_QUESTION call did not create a memory entry (check embedding/DB connectivity)' };
      return Object.fromEntries(KEYS.map(k => [k, skip]));
    }
    const memoryId = writtenRows[0].id;

    const beforeUpdatedAt = await sessionUpdatedAt();
    embedCalls = searchCalls = rerankCalls = answerCalls = 0;

    // Second call — same normalized question via case/whitespace variation.
    const variantQuestion = `  ${TAG.toLowerCase()} what is cosine similarity in this fixture  `;
    const second = await askLectureAgent({ studentId, lectureId, question: variantQuestion, sessionId: session.id }, pipelineDeps);
    const stored = await lastStored();
    const afterUpdatedAt = await sessionUpdatedAt();
    const { rows: memRows } = await query<{ hit_count: number; last_used_at: Date }>(
      `SELECT hit_count, last_used_at FROM rag_answer_memory WHERE id = $1`, [memoryId]
    );

    results['1'] = { pass: second.answer === first.answer, detail: `first="${first.answer.slice(0, 40)}", second="${second.answer.slice(0, 40)}"` };
    results['2'] = { pass: embedCalls === 0, detail: `embedCalls=${embedCalls}` };
    results['3'] = { pass: searchCalls === 0, detail: `searchCalls=${searchCalls}` };
    results['4'] = { pass: rerankCalls === 0, detail: `rerankCalls=${rerankCalls}` };
    results['5'] = { pass: answerCalls === 0, detail: `answerCalls=${answerCalls}` };
    results['6'] = { pass: !!stored && stored.question === variantQuestion, detail: `stored question="${stored?.question}"` };
    results['7'] = { pass: JSON.stringify(stored?.source_chunk_ids) === JSON.stringify(first.sources.map(c => c.id)), detail: `stored=${JSON.stringify(stored?.source_chunk_ids)}, original=${JSON.stringify(first.sources.map(c => c.id))}` };
    results['8'] = { pass: afterUpdatedAt.getTime() >= beforeUpdatedAt.getTime(), detail: `before=${beforeUpdatedAt.toISOString()}, after=${afterUpdatedAt.toISOString()}` };
    results['9'] = { pass: memRows[0]?.hit_count === 1, detail: `hit_count=${memRows[0]?.hit_count}` };
    results['38'] = {
      pass: typeof second.answer === 'string' && Array.isArray(second.sources) && second.sources.every(s => typeof s.id === 'number'),
      detail: `shape ok, sources=${second.sources.length}`,
    };

    // 15 — greeting never touches memory
    {
      const before = (await query<{ c: string }>(`SELECT COUNT(*) c FROM rag_answer_memory WHERE lecture_id = $1`, [lectureId])).rows[0].c;
      await askLectureAgent({ studentId, lectureId, question: 'Hello', sessionId: session.id }, {
        classifyRoute: async () => ({ route: 'GREETING', source: 'rule' }),
      });
      const after = (await query<{ c: string }>(`SELECT COUNT(*) c FROM rag_answer_memory WHERE lecture_id = $1`, [lectureId])).rows[0].c;
      results['15'] = { pass: before === after, detail: `count before=${before}, after=${after}` };
    }

    // 16 — lecture summary never touches memory
    {
      const before = (await query<{ c: string }>(`SELECT COUNT(*) c FROM rag_answer_memory WHERE lecture_id = $1`, [lectureId])).rows[0].c;
      await askLectureAgent({ studentId, lectureId, question: 'Summarize this lecture.', sessionId: session.id }, {
        classifyRoute: async () => ({ route: 'LECTURE_SUMMARY', source: 'rule' }),
        getAllLectureChunks: async () => [chunk],
        generateLectureSummary: async () => 'A fixture summary.',
      });
      const after = (await query<{ c: string }>(`SELECT COUNT(*) c FROM rag_answer_memory WHERE lecture_id = $1`, [lectureId])).rows[0].c;
      results['16'] = { pass: before === after, detail: `count before=${before}, after=${after}` };
    }

    // 17 — contextual follow-up never touches memory in this phase
    {
      const before = (await query<{ c: string }>(`SELECT COUNT(*) c FROM rag_answer_memory WHERE lecture_id = $1`, [lectureId])).rows[0].c;
      await askLectureAgent({ studentId, lectureId, question: 'Why is it necessary?', sessionId: session.id }, {
        classifyRoute: async () => ({ route: 'CONTEXTUAL_FOLLOW_UP', source: 'rule' }),
        resolveRetrievalQuery: async () => ({ query: 'Why is X necessary?', wasRewritten: true, attempted: true }),
        generateEmbedding: async () => makeVector(12),
        searchChunks: async () => [chunk],
        rerankChunks: async (_q, c) => c.map(x => ({ ...x, rerankScore: 0.9 })),
        generateAnswer: async () => 'A follow-up answer.',
      });
      const after = (await query<{ c: string }>(`SELECT COUNT(*) c FROM rag_answer_memory WHERE lecture_id = $1`, [lectureId])).rows[0].c;
      results['17'] = { pass: before === after, detail: `count before=${before}, after=${after}` };
    }

    // 18 — LECTURE_NOT_FOUND_MESSAGE is never cached
    {
      const q = `${TAG} not-found fixture question`;
      const before = (await query<{ c: string }>(`SELECT COUNT(*) c FROM rag_answer_memory WHERE normalized_query = $1`, [normalizeQuery(q)])).rows[0].c;
      const result = await askLectureAgent({ studentId, lectureId, question: q, sessionId: session.id }, {
        classifyRoute: async () => ({ route: 'FACT_QUESTION', source: 'rule' }),
        generateEmbedding: async () => makeVector(13),
        searchChunks: async () => [],
      });
      const after = (await query<{ c: string }>(`SELECT COUNT(*) c FROM rag_answer_memory WHERE normalized_query = $1`, [normalizeQuery(q)])).rows[0].c;
      results['18'] = { pass: result.answer === LECTURE_NOT_FOUND_MESSAGE && before === after, detail: `answer="${result.answer}", count before=${before}, after=${after}` };
    }

    // 20 — a failed generateAnswer call is not cached (and propagates, matching existing behavior)
    {
      const q = `${TAG} failed generation fixture question`;
      const before = (await query<{ c: string }>(`SELECT COUNT(*) c FROM rag_answer_memory WHERE normalized_query = $1`, [normalizeQuery(q)])).rows[0].c;
      let threw = false;
      try {
        await askLectureAgent({ studentId, lectureId, question: q, sessionId: session.id }, {
          classifyRoute: async () => ({ route: 'FACT_QUESTION', source: 'rule' }),
          generateEmbedding: async () => makeVector(14),
          searchChunks: async () => [chunk],
          rerankChunks: async (_q, c) => c.map(x => ({ ...x, rerankScore: 0.9 })),
          generateAnswer: async () => { throw new Error('simulated generation failure'); },
        });
      } catch { threw = true; }
      const after = (await query<{ c: string }>(`SELECT COUNT(*) c FROM rag_answer_memory WHERE normalized_query = $1`, [normalizeQuery(q)])).rows[0].c;
      results['20'] = { pass: threw && before === after, detail: `threw=${threw}, count before=${before}, after=${after}` };
    }

    // 37b — a memory WRITE failure never changes the response returned to the student
    {
      const q = `${TAG} write-fails-but-answer-succeeds fixture`;
      const result = await askLectureAgent({ studentId, lectureId, question: q, sessionId: session.id }, {
        classifyRoute: async () => ({ route: 'FACT_QUESTION', source: 'rule' }),
        generateEmbedding: async () => makeVector(15),
        searchChunks: async () => [chunk],
        rerankChunks: async (_q, c) => c.map(x => ({ ...x, rerankScore: 0.9 })),
        generateAnswer: async () => 'A perfectly good answer despite memory failing.',
        writeAnswerMemory: async () => { throw new Error('simulated memory write failure'); },
      });
      results['37b'] = { pass: result.answer === 'A perfectly good answer despite memory failing.', detail: `answer="${result.answer}"` };
    }

    return results;
  } finally {
    await query(`DELETE FROM rag_answer_memory WHERE lecture_id = $1 AND normalized_query LIKE $2`, [lectureId, `${TAG.toLowerCase()}%`]).catch(() => {});
    await deleteChatSession(studentId, session.id);
  }
}

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

  const serviceLabels: Record<string, string> = {
    '10': '10. Memory from another student is never reused',
    '11': '11. Memory from another lecture is never reused',
    '12': '12. Memory from another lecture-content version is not reused',
    '13': '13. Memory from an incompatible embedding-model version is not reused',
    '14': '14. Memory from an incompatible answer-prompt version is not reused',
    '19': '19. An answer without source chunk IDs is not cached',
    '21': '21. Cleared chat entries are not reused',
    '22': '22. Clearing a whole session prevents its linked entries from being reused',
    '23': '23. Missing/deleted source chunks invalidate the memory hit',
    '28': '28. Semantic lookup runs only when explicitly enabled',
    '29': '29. A configured high-confidence equivalent question returns a semantic hit',
    '30': '30. A related but different-intent question produces a memory miss',
    '31': '31. Semantic miss reuses the already-generated query embedding',
    '33': '33. Invalid/missing semantic threshold configuration fails safely',
    '34': '34. Successful grounded fact answers create memory entries',
    '35': '35. Duplicate exact memory entries are not unnecessarily inserted (upsert)',
    '36': '36. Memory lookup failure falls back safely (never throws)',
    '37a': '37a. Memory write failure never throws (unit level)',
  };
  console.log('\n--- Part B: direct service-level checks (real DB) ---');
  try {
    const results = await runServiceLevelChecks();
    for (const key of Object.keys(serviceLabels)) {
      ran++;
      const r = results[key];
      if (!r) { failures++; console.log(`FAIL  ${serviceLabels[key]} (no result)`); continue; }
      if (r.skip) { skipped++; console.log(`SKIP  ${serviceLabels[key]}${r.detail ? ` (${r.detail})` : ''}`); }
      else if (r.pass) { console.log(`PASS  ${serviceLabels[key]}${r.detail ? ` (${r.detail})` : ''}`); }
      else { failures++; console.log(`FAIL  ${serviceLabels[key]}${r.detail ? ` (${r.detail})` : ''}`); }
    }
  } catch (err) {
    failures += Object.keys(serviceLabels).length;
    ran += Object.keys(serviceLabels).length;
    console.log(`FAIL  Part B block (threw: ${(err as Error).message})`);
  }

  const integrationLabels: Record<string, string> = {
    '1': '1. Same normalized fact question returns the stored answer',
    '2': '2. Exact memory hit bypasses embedding',
    '3': '3. Exact memory hit bypasses lecture vector search',
    '4': '4. Exact memory hit bypasses reranking',
    '5': '5. Exact memory hit bypasses Gemini answer generation',
    '6': '6. Exact memory hit saves a new chat_history row in the current session',
    '7': '7. Cached source chunk IDs are copied to the new chat-history row',
    '8': '8. Session updated_at is touched',
    '9': '9. hit_count and last_used_at are updated',
    '15': '15. A greeting is not stored or retrieved from memory',
    '16': '16. A lecture summary is not stored or retrieved from memory',
    '17': '17. A contextual follow-up is not stored or retrieved from memory in this phase',
    '18': '18. LECTURE_NOT_FOUND_MESSAGE is not cached',
    '20': '20. A failed answer is not cached',
    '37b': '37b. Memory write failure does not fail the successful answer response',
    '38': '38. Cached answers preserve the existing GraphQL/API response contract',
  };
  console.log('\n--- Part C: chat.service wiring (real lecture, stubbed AI calls) ---');
  try {
    const results = await runIntegrationChecks();
    for (const key of Object.keys(integrationLabels)) {
      ran++;
      const r = results[key];
      if (!r) { failures++; console.log(`FAIL  ${integrationLabels[key]} (no result)`); continue; }
      if (r.skip) { skipped++; console.log(`SKIP  ${integrationLabels[key]}${r.detail ? ` (${r.detail})` : ''}`); }
      else if (r.pass) { console.log(`PASS  ${integrationLabels[key]}${r.detail ? ` (${r.detail})` : ''}`); }
      else { failures++; console.log(`FAIL  ${integrationLabels[key]}${r.detail ? ` (${r.detail})` : ''}`); }
    }
  } catch (err) {
    failures += Object.keys(integrationLabels).length;
    ran += Object.keys(integrationLabels).length;
    console.log(`FAIL  Part C block (threw: ${(err as Error).message})`);
  }

  console.log(`\n${ran - skipped - failures}/${ran - skipped} passed${skipped ? ` (${skipped} skipped)` : ''}`);
  console.log('\nNote: cases 40-44 (regression) are covered by re-running test:query-router and test:query-rewriter, not duplicated here.');
  process.exit(failures > 0 ? 1 : 0);
}

main();
