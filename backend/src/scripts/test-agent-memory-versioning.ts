/**
 * Validates agent-aware answer-memory versioning (rag-answer-memory.service.ts):
 * computeAgentConfigFingerprint, getEffectiveAnswerPromptVersion, and the
 * optional answerPromptVersion on lookup/write.
 *
 * No real database and no LLM: the shared pg pool's `query` is replaced
 * with an in-memory fake that models rag_answer_memory's UNIQUE key (incl.
 * answer_prompt_version) and its exact/semantic lookup SQL. The fake throws
 * on any statement shape the service isn't supposed to issue, and every
 * statement is recorded so tests can assert nothing was deleted or updated
 * outside the upsert. Embeddings are stubbed; the LLM provider is
 * replaced with a tripwire that fails the run if it is ever called.
 *
 * Usage: node_modules/.bin/ts-node --transpile-only src/scripts/test-agent-memory-versioning.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import pool from '../config/database';
import { LectureAgentProfile } from '../types';
import { ANSWER_PROMPT_VERSION } from '../services/answer-generation.service';
import { EMBEDDING_MODEL_VERSION } from '../services/embedding.service';
import {
  computeAgentConfigFingerprint,
  getEffectiveAnswerPromptVersion,
  getActiveDatasetVersionId,
  lookupAnswerMemory,
  writeAnswerMemory,
  LookupParams,
  WriteMemoryParams,
} from '../services/rag-answer-memory.service';
import { openAiLlmProvider } from '../llm/providers/openai-llm.provider';
import { INSTRUCTIONS_BY_VIDEO_ID } from './seed-agent-profiles';

interface CaseResult { pass: boolean; detail?: string }
interface Case { label: string; run: () => Promise<CaseResult> }
const cases: Case[] = [];

// ── Fixtures ────────────────────────────────────────────────────────────

const mkProfile = (lectureId: number, name: string, instructions: string): LectureAgentProfile => ({
  lecture_id: lectureId, agent_name: name, instructions, is_active: true,
  created_at: new Date('2026-10-11T00:00:00Z'), updated_at: new Date('2026-10-11T00:00:00Z'),
});
const NOVA = mkProfile(4, 'Nova', INSTRUCTIONS_BY_VIDEO_ID['pCNit2x2gjY']);
const CLARITY = mkProfile(2, 'Clarity', INSTRUCTIONS_BY_VIDEO_ID['1mi-gFalmSQ']);

const STUDENT = '1e8039ae-e9b0-448f-b563-10351fab051c';
const LECTURE = 4;
const QUESTION = 'What is the best learning methodology?';
const FAKE_VERSION_ID = 7;
const EMBEDDING = [0.1, 0.2, 0.3];
const stubEmbedding = async () => EMBEDDING;

interface Row {
  id: number; student_id: string; lecture_id: number; normalized_query: string;
  dataset_version_id: number; embedding_model_version: string; answer_prompt_version: string;
  answer: string; source_chunk_ids: number[]; cache_eligible: boolean;
}
interface Statement { kind: string; text: string; params: unknown[] }

const seedRows = (): Row[] => ([
  // Two generic rows stored under the current global ANSWER_PROMPT_VERSION.
  { id: 79, student_id: STUDENT, lecture_id: LECTURE, normalized_query: 'what is the best learning methodology',
    dataset_version_id: FAKE_VERSION_ID, embedding_model_version: EMBEDDING_MODEL_VERSION, answer_prompt_version: ANSWER_PROMPT_VERSION,
    answer: 'GENERIC ANSWER', source_chunk_ids: [1, 2], cache_eligible: true },
  { id: 80, student_id: STUDENT, lecture_id: LECTURE, normalized_query: 'why is doing a task yourself the best way',
    dataset_version_id: FAKE_VERSION_ID, embedding_model_version: EMBEDDING_MODEL_VERSION, answer_prompt_version: ANSWER_PROMPT_VERSION,
    answer: 'ANOTHER GENERIC ANSWER', source_chunk_ids: [3], cache_eligible: true },
]);

// Installs the in-memory fake over pool.query for the duration of `fn`.
async function withFakeDb<T>(rows: Row[], fn: (ctx: { rows: Row[]; statements: Statement[] }) => Promise<T>): Promise<T> {
  const statements: Statement[] = [];
  let nextId = 1000;
  const original = pool.query;
  const llmTripwire = async () => { throw new Error('LLM provider was called — tests must never reach it'); };
  const origGen = openAiLlmProvider.generate;
  const origStream = openAiLlmProvider.generateStream;
  openAiLlmProvider.generate = llmTripwire;
  openAiLlmProvider.generateStream = llmTripwire as never;

  (pool as unknown as { query: unknown }).query = async (text: string, params: unknown[] = []) => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t.includes('SELECT active_version_id FROM lectures')) {
      statements.push({ kind: 'active-version', text: t, params });
      return { rows: [{ active_version_id: FAKE_VERSION_ID }], rowCount: 1 };
    }
    if (t.includes('FROM dataset_version_chunks WHERE version_id = $1 AND chunk_id = ANY')) {
      statements.push({ kind: 'version-membership-guard', text: t, params });
      return { rows: [{ n: String(new Set(params[1] as number[]).size) }], rowCount: 1 };
    }
    if (t.includes('FROM rag_answer_memory m') && t.includes('m.normalized_query = $3')) {
      statements.push({ kind: 'exact-lookup', text: t, params });
      const [student, lecture, normalized, hash, model, version] = params as [string, number, string, number, string, string];
      const hit = rows.filter(r => r.student_id === student && r.lecture_id === lecture && r.normalized_query === normalized
        && r.dataset_version_id === hash && r.embedding_model_version === model && r.answer_prompt_version === version && r.cache_eligible);
      return { rows: hit.slice(0, 1).map(r => ({ id: r.id, answer: r.answer, source_chunk_ids: r.source_chunk_ids })), rowCount: hit.length };
    }
    if (t.includes('SELECT id FROM rag_answer_memory')) {
      statements.push({ kind: 'stale-diagnostic', text: t, params });
      const [student, lecture, normalized] = params as [string, number, string];
      const hit = rows.filter(r => r.student_id === student && r.lecture_id === lecture && r.normalized_query === normalized);
      return { rows: hit.slice(0, 1).map(r => ({ id: r.id })), rowCount: hit.length };
    }
    if (t.includes('m.question_embedding <=>')) {
      statements.push({ kind: 'semantic-lookup', text: t, params });
      const [student, lecture, hash, model, version] = params as [string, number, number, string, string];
      const hit = rows.filter(r => r.student_id === student && r.lecture_id === lecture && r.dataset_version_id === hash
        && r.embedding_model_version === model && r.answer_prompt_version === version && r.cache_eligible);
      return { rows: hit.map(r => ({ id: r.id, answer: r.answer, source_chunk_ids: r.source_chunk_ids, similarity: 0.99 })), rowCount: hit.length };
    }
    if (t.includes('FROM lecture_qna_chunks') && t.includes('ANY($2)')) {
      statements.push({ kind: 'fetch-chunks', text: t, params });
      const ids = params[1] as number[];
      return { rows: ids.map(id => ({ id, lecture_id: params[0], topic: 't', question: 'q', answer: 'a', chunk_text: 'c', start_time: null, end_time: null, keywords: null })), rowCount: ids.length };
    }
    if (/^INSERT INTO rag_answer_memory/i.test(t)) {
      statements.push({ kind: 'upsert', text: t, params });
      const [student, lecture, , , , normalized, , answer, chunkIds, hash, model, version] = params as [string, number, number, string, string, string, string, string, number[], number, string, string];
      const existing = rows.find(r => r.student_id === student && r.lecture_id === lecture && r.normalized_query === normalized
        && r.dataset_version_id === hash && r.embedding_model_version === model && r.answer_prompt_version === version);
      if (existing) { existing.answer = answer; existing.source_chunk_ids = chunkIds; }    // ON CONFLICT ... DO UPDATE
      else rows.push({ id: nextId++, student_id: student, lecture_id: lecture, normalized_query: normalized, dataset_version_id: hash,
        embedding_model_version: model, answer_prompt_version: version, answer, source_chunk_ids: chunkIds, cache_eligible: true });
      return { rows: [], rowCount: 1 };
    }
    statements.push({ kind: 'UNEXPECTED', text: t, params });
    throw new Error(`unexpected SQL from answer-memory service: ${t.slice(0, 90)}`);
  };

  try {
    return await fn({ rows, statements });
  } finally {
    (pool as unknown as { query: unknown }).query = original;
    openAiLlmProvider.generate = origGen;
    openAiLlmProvider.generateStream = origStream;
  }
}

const lookupParams = (version?: string): LookupParams =>
  ({ studentId: STUDENT, lectureId: LECTURE, question: QUESTION, generateEmbedding: stubEmbedding, ...(version !== undefined ? { answerPromptVersion: version } : {}) });
const writeParams = (answer: string, version?: string): WriteMemoryParams => ({
  studentId: STUDENT, lectureId: LECTURE, sourceChatHistoryId: 1, originalQuestion: QUESTION, retrievalQuery: QUESTION,
  answer, sourceChunkIds: [1, 2], questionEmbedding: EMBEDDING, datasetVersionId: FAKE_VERSION_ID,
  ...(version !== undefined ? { answerPromptVersion: version } : {}),
});

// ── A–E: fingerprint and effective version ─────────────────────────────

cases.push({
  label: 'A. Same agent configuration: same fingerprint and same effective version (stable, 64-hex SHA-256)',
  run: async () => {
    const again = mkProfile(4, 'Nova', INSTRUCTIONS_BY_VIDEO_ID['pCNit2x2gjY']);
    const fpA = computeAgentConfigFingerprint(NOVA);
    const padded = mkProfile(4, 'Nova', `\n  ${NOVA.instructions}  \n`); // outer whitespace is trimmed in the prompt too
    const pass = fpA === computeAgentConfigFingerprint(again) && /^[0-9a-f]{64}$/.test(fpA)
      && getEffectiveAnswerPromptVersion(NOVA) === getEffectiveAnswerPromptVersion(again)
      && getEffectiveAnswerPromptVersion(NOVA) === getEffectiveAnswerPromptVersion(padded)
      && getEffectiveAnswerPromptVersion(NOVA) === `${ANSWER_PROMPT_VERSION}+agent:${fpA}`;
    return { pass, detail: getEffectiveAnswerPromptVersion(NOVA).slice(0, 30) + '…' };
  },
});

cases.push({
  label: 'B. Different instructions (even a one-character edit) produce different effective versions',
  run: async () => {
    const edited = mkProfile(4, 'Nova', NOVA.instructions + '.');
    const other = mkProfile(4, 'Nova', CLARITY.instructions);
    const v = [NOVA, edited, other].map(p => getEffectiveAnswerPromptVersion(p));
    return { pass: new Set(v).size === 3 };
  },
});

cases.push({
  label: 'C. Different agent names produce different effective versions (same instructions)',
  run: async () => {
    const renamed = mkProfile(4, 'Nova2', NOVA.instructions);
    return { pass: getEffectiveAnswerPromptVersion(NOVA) !== getEffectiveAnswerPromptVersion(renamed) };
  },
});

cases.push({
  label: 'C2. Canonicalization is unambiguous: field-boundary shifts and quote/newline injection never collide',
  run: async () => {
    const pairs: [LectureAgentProfile, LectureAgentProfile][] = [
      [mkProfile(1, 'ab', 'c'), mkProfile(1, 'a', 'bc')],
      [mkProfile(1, 'a', 'b|c'), mkProfile(1, 'a|b', 'c')],
      [mkProfile(1, 'x","instructions":"y', 'z'), mkProfile(1, 'x', 'y","z')],
      [mkProfile(1, 'a\n', 'b'), mkProfile(1, 'a', '\nb')],
    ];
    const bad = pairs.filter(([a, b]) => computeAgentConfigFingerprint(a) === computeAgentConfigFingerprint(b)).length;
    return { pass: bad === 0, detail: `collisions=${bad}/${pairs.length}` };
  },
});

cases.push({
  label: 'D. Agent versions differ from the generic tutor version and carry the "+agent:" marker',
  run: async () => {
    const generic = getEffectiveAnswerPromptVersion(null);
    const nova = getEffectiveAnswerPromptVersion(NOVA);
    const clarity = getEffectiveAnswerPromptVersion(CLARITY);
    const pass = generic === ANSWER_PROMPT_VERSION && generic === getEffectiveAnswerPromptVersion(undefined)
      && nova !== generic && clarity !== generic && nova !== clarity
      && nova.includes('+agent:') && !generic.includes('+agent:');
    return { pass, detail: `generic=${generic}` };
  },
});

cases.push({
  label: 'E. Changing the global ANSWER_PROMPT_VERSION changes the effective version (generic and agent-specific)',
  run: async () => {
    const pass = getEffectiveAnswerPromptVersion(NOVA, 'v1') !== getEffectiveAnswerPromptVersion(NOVA, 'v2')
      && getEffectiveAnswerPromptVersion(null, 'v2') === 'v2'
      && getEffectiveAnswerPromptVersion(NOVA, 'v2').startsWith('v2+agent:')
      && computeAgentConfigFingerprint(NOVA) === getEffectiveAnswerPromptVersion(NOVA, 'v2').split('+agent:')[1];
    return { pass };
  },
});

// ── F: lookup and write consistency ────────────────────────────────────

cases.push({
  label: 'F. Lookup and write use the SAME effective version: written agent answer is found; generic/other-agent/edited-agent lookups miss',
  run: async () => {
    return withFakeDb([], async ({ rows, statements }) => {
      const novaV = getEffectiveAnswerPromptVersion(NOVA);
      await writeAnswerMemory(writeParams('NOVA ANSWER', novaV));
      const upsert = statements.find(s => s.kind === 'upsert')!;
      const writtenVersion = upsert.params[11];

      const hit = await lookupAnswerMemory(lookupParams(novaV));
      const lookupStmt = statements.filter(s => s.kind === 'exact-lookup').pop()!;
      const boundVersion = lookupStmt.params[5];

      const genericMiss = await lookupAnswerMemory(lookupParams());                                   // old generic tutor
      const clarityMiss = await lookupAnswerMemory(lookupParams(getEffectiveAnswerPromptVersion(CLARITY)));
      const edited = mkProfile(4, 'Nova', NOVA.instructions + ' (edited)');
      const editedMiss = await lookupAnswerMemory(lookupParams(getEffectiveAnswerPromptVersion(edited)));

      const pass = writtenVersion === novaV && boundVersion === novaV && writtenVersion === boundVersion
        && hit.hit?.matchType === 'EXACT' && hit.hit.answer === 'NOVA ANSWER'
        && genericMiss.hit === null && clarityMiss.hit === null && editedMiss.hit === null
        && rows.length === 1;
      return { pass, detail: `written=${String(writtenVersion).slice(0, 16)}… bound=${String(boundVersion).slice(0, 16)}… rows=${rows.length}` };
    });
  },
});

cases.push({
  label: 'F2. Semantic lookup also binds the effective version (same value as exact lookup and write)',
  run: async () => {
    return withFakeDb([], async ({ statements }) => {
      const novaV = getEffectiveAnswerPromptVersion(NOVA);
      await writeAnswerMemory(writeParams('NOVA ANSWER', novaV));
      // Different wording so the exact lookup misses and the semantic path runs.
      const params: LookupParams = { ...lookupParams(novaV), question: 'Which learning method is the best one?' };
      const r = await lookupAnswerMemory(params, { semanticEnabled: true, similarityThreshold: 0.5 });
      const sem = statements.find(s => s.kind === 'semantic-lookup');
      const genericSem = await lookupAnswerMemory({ ...params, answerPromptVersion: undefined }, { semanticEnabled: true, similarityThreshold: 0.5 });
      const pass = !!sem && sem.params[4] === novaV && r.hit?.matchType === 'SEMANTIC' && genericSem.hit === null;
      return { pass, detail: `semanticVersionBound=${sem ? String(sem.params[4]).slice(0, 16) + '…' : 'none'}` };
    });
  },
});

// ── G: dataset-version binding ─────────────────────────────────────────

cases.push({
  label: 'G. Cache is bound to the active dataset version: lookups/writes use that id (not a content hash), identical with or without an agent',
  run: async () => {
    return withFakeDb([], async ({ statements }) => {
      const direct = await getActiveDatasetVersionId(LECTURE);
      const noAgent = await lookupAnswerMemory(lookupParams());
      const withAgent = await lookupAnswerMemory(lookupParams(getEffectiveAnswerPromptVersion(NOVA)));
      const versionSql = statements.find(s => s.kind === 'active-version')!;
      const pass = getActiveDatasetVersionId.length === 1
        && JSON.stringify(versionSql.params) === JSON.stringify([LECTURE])
        && direct === FAKE_VERSION_ID && noAgent.datasetVersionId === direct && withAgent.datasetVersionId === direct
        && !/agent|instruction|profile/i.test(versionSql.text)
        && !statements.some(s => s.text.includes('string_agg'));
      return { pass, detail: `arity=${getActiveDatasetVersionId.length}, version=${direct}, noPerRequestHashing=${!statements.some(s => s.text.includes('string_agg'))}` };
    });
  },
});

// ── H: backward compatibility ──────────────────────────────────────────

cases.push({
  label: 'H. Calls without a profile/version still work and use the global ANSWER_PROMPT_VERSION for both lookup and write',
  run: async () => {
    // Compile-time: the pre-change param shapes (no answerPromptVersion) must still be accepted.
    const legacyLookup: { studentId: string; lectureId: number; question: string; generateEmbedding: (t: string, q?: boolean) => Promise<number[]> } = lookupParams();
    return withFakeDb([], async ({ rows, statements }) => {
      await writeAnswerMemory({
        studentId: STUDENT, lectureId: LECTURE, sourceChatHistoryId: 1, originalQuestion: QUESTION, retrievalQuery: QUESTION,
        answer: 'GENERIC NEW', sourceChunkIds: [1], questionEmbedding: EMBEDDING, datasetVersionId: FAKE_VERSION_ID,
      });
      const r = await lookupAnswerMemory(legacyLookup);
      const upsert = statements.find(s => s.kind === 'upsert')!;
      const lookup = statements.find(s => s.kind === 'exact-lookup')!;
      const pass = upsert.params[11] === ANSWER_PROMPT_VERSION && lookup.params[5] === ANSWER_PROMPT_VERSION
        && r.hit?.answer === 'GENERIC NEW' && rows[0].answer_prompt_version === ANSWER_PROMPT_VERSION;
      return { pass, detail: `version=${String(upsert.params[11])}` };
    });
  },
});

cases.push({
  label: 'H2. A blank answerPromptVersion is rejected (lookup = failed miss, write = nothing stored), never defaulted silently',
  run: async () => {
    return withFakeDb([], async ({ rows, statements }) => {
      const lookup = await lookupAnswerMemory(lookupParams('   '));
      await writeAnswerMemory(writeParams('X', ''));
      const pass = lookup.hit === null && lookup.lookupFailed === true && rows.length === 0
        && statements.every(s => s.kind !== 'upsert' && s.kind !== 'exact-lookup');
      return { pass, detail: `lookupFailed=${lookup.lookupFailed}, rows=${rows.length}, statements=${statements.length}` };
    });
  },
});

// ── I: existing cache rows are preserved ───────────────────────────────

cases.push({
  label: 'I. Existing cache rows are neither deleted nor modified; an agent answer is stored as a separate row',
  run: async () => {
    const rows = seedRows();
    const before = JSON.stringify(rows);
    return withFakeDb(rows, async ({ rows: live, statements }) => {
      const novaV = getEffectiveAnswerPromptVersion(NOVA);
      // Same student/lecture/question as legacy row #79, but under the agent version.
      const preLookup = await lookupAnswerMemory(lookupParams(novaV));               // must NOT hit generic row 79
      await writeAnswerMemory(writeParams('NOVA ANSWER', novaV));
      await writeAnswerMemory(writeParams('NOVA ANSWER v2', novaV));                  // re-write same agent version = update that row only
      const genericStillServed = await lookupAnswerMemory(lookupParams());            // legacy lookup unaffected
      const legacyRows = live.filter(r => r.answer_prompt_version === ANSWER_PROMPT_VERSION);
      const agentRows = live.filter(r => r.answer_prompt_version === novaV);
      const kinds = new Set(statements.map(s => s.kind));
      const pass = preLookup.hit === null
        && JSON.stringify(legacyRows) === before                                       // both legacy rows byte-identical
        && agentRows.length === 1 && agentRows[0].answer === 'NOVA ANSWER v2'
        && genericStillServed.hit?.answer === 'GENERIC ANSWER'
        && live.length === 3 && !kinds.has('UNEXPECTED')
        && statements.every(s => !/^\s*(DELETE|UPDATE|TRUNCATE|DROP)/i.test(s.text));
      return { pass, detail: `rows=${live.length} (legacy=${legacyRows.length}, agent=${agentRows.length}), statementKinds=${[...kinds].join(',')}` };
    });
  },
});

cases.push({
  label: 'I2. The write\'s conflict target includes answer_prompt_version, so an agent write can never overwrite a generic row',
  run: async () => {
    return withFakeDb([], async ({ statements }) => {
      await writeAnswerMemory(writeParams('A', getEffectiveAnswerPromptVersion(NOVA)));
      const sql = statements.find(s => s.kind === 'upsert')!.text;
      const m = sql.match(/ON CONFLICT \(([^)]+)\)/);
      const cols = m ? m[1].split(',').map(c => c.trim()) : [];
      return { pass: cols.includes('answer_prompt_version') && cols.includes('student_id') && cols.includes('lecture_id'), detail: cols.join(', ') };
    });
  },
});

// ── J: no external calls ───────────────────────────────────────────────

cases.push({
  label: 'J. No LLM calls: tripwire provider never fired; service references no generation/LLM entry points',
  run: async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'rag-answer-memory.service.ts'), 'utf8');
    const code = src.replace(/\/\/.*$/gm, '');
    const usesLlm = /generateAnswer\b|generateAnswerFromLLM|resolveLlmProvider|openAiLlmProvider|generateContent/.test(code);
    // Exercise every versioned code path once with the tripwire installed.
    const outcome = await withFakeDb([], async () => {
      const v = getEffectiveAnswerPromptVersion(CLARITY);
      await writeAnswerMemory(writeParams('c', v));
      await lookupAnswerMemory(lookupParams(v));
      await lookupAnswerMemory(lookupParams(v), { semanticEnabled: true, similarityThreshold: 0.5 });
      return 'ok';
    });
    return { pass: outcome === 'ok' && !usesLlm, detail: `usesLlm=${usesLlm}` };
  },
});

async function main(): Promise<void> {
  let failures = 0;
  for (const c of cases) {
    try {
      const r = await c.run();
      if (r.pass) console.log(`PASS  ${c.label}${r.detail ? ` (${r.detail})` : ''}`);
      else { failures++; console.log(`FAIL  ${c.label}${r.detail ? ` (${r.detail})` : ''}`); }
    } catch (err) {
      failures++;
      console.log(`FAIL  ${c.label} (threw: ${(err as Error).message})`);
    }
  }
  console.log(`\n${cases.length - failures}/${cases.length} passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
