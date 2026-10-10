/**
 * Mocked integration tests for lecture-agent integration in
 * chat.service.ts's askLectureAgent (Step 6).
 *
 * Nothing real is touched:
 *  - The shared pg pool's `query` is replaced with an in-memory fake that
 *    models just the tables askLectureAgent uses (lectures, chat_history,
 *    chat_sessions, student_questions, lecture_agent_profiles,
 *    rag_answer_memory incl. its UNIQUE key). It throws on any SQL shape it
 *    doesn't know, so an unexpected statement fails the test.
 *  - Every LLM/network dependency of the pipeline is injected through
 *    AskLectureAgentDeps (input/output guardrails, router, embedding,
 *    search, rerank, decomposition, answer generation, greeting, summary).
 *  - The Gemini provider is replaced with a tripwire that fails the run if
 *    anything reaches it.
 * The real lecture-agent-profile service and the real answer-memory service
 * run against the fake, so agent selection and cache-version propagation
 * are exercised for real.
 *
 * Usage: node_modules/.bin/ts-node --transpile-only src/scripts/test-chat-agent-integration.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import pool from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { LectureAgentProfile, QnaChunk } from '../types';
import {
  askLectureAgent,
  AskLectureAgentDeps,
  LECTURE_NOT_FOUND_MESSAGE,
} from '../services/chat.service';
import { getEffectiveAnswerPromptVersion } from '../services/rag-answer-memory.service';
import { EMBEDDING_MODEL_VERSION } from '../services/embedding.service';
import { geminiLlmProvider } from '../llm/providers/gemini-llm.provider';
import type { OutputGuardrailResult } from '../rag/guardrails/output/answer-verification.types';
import type { FinishedTrace } from '../observability/types';
import { INSTRUCTIONS_BY_VIDEO_ID } from './seed-agent-profiles';

interface CaseResult { pass: boolean; detail?: string }
interface Case { label: string; run: () => Promise<CaseResult> }
const cases: Case[] = [];

// ── Fixtures ────────────────────────────────────────────────────────────

const STUDENT = '1e8039ae-e9b0-448f-b563-10351fab051c';
// A session is bound to one student AND one lecture (validated by askLectureAgent),
// so each lecture gets its own session id in the fake world.
const sessionOf = (lectureId: number): number => 1000 + lectureId;
const QUESTION = 'Who is the instructor of this course?';
const HASH = 'fake-content-hash';
const EMB = [0.1, 0.2, 0.3];

const profileRow = (lectureId: number, name: string, videoId: string, isActive = true): LectureAgentProfile => ({
  lecture_id: lectureId, agent_name: name, instructions: INSTRUCTIONS_BY_VIDEO_ID[videoId], is_active: isActive,
  created_at: new Date('2026-10-11T00:00:00Z'), updated_at: new Date('2026-10-11T00:00:00Z'),
});

const lectureRow = (id: number, title: string, status = 'READY') => ({ id, title, status, youtube_video_id: null });

interface MemRow {
  id: number; student_id: string; lecture_id: number; normalized_query: string; lecture_content_hash: string;
  embedding_model_version: string; answer_prompt_version: string; answer: string; source_chunk_ids: number[];
  cache_eligible: boolean; hit_count: number;
}
interface Stmt { kind: string; text: string; params: unknown[] }

interface World {
  lectures: ReturnType<typeof lectureRow>[];
  profiles: LectureAgentProfile[];
  memory: MemRow[];
  sessions: { id: number; student_id: string; lecture_id: number }[];
  history: { id: number; student_id: string; lecture_id: number; session_id: number; question: string; answer: string; source_chunk_ids: number[] }[];
  studentQuestions: { student_id: string; lecture_id: number; question: string }[];
  stmts: Stmt[];
  profileQueryError?: Error;
}

const newWorld = (over: Partial<World> = {}): World => ({
  lectures: [
    lectureRow(4, 'Introductory Lecture'),
    lectureRow(2, 'Lecture 2: Fundamentals of Crafting Simple, Fast, and Accurate Prompts'),
    lectureRow(9, 'Lecture without a profile'),
    lectureRow(8, 'Lecture with a disabled profile'),
    lectureRow(7, 'Lecture still processing', 'PROCESSING'),
  ],
  profiles: [
    profileRow(4, 'Nova', 'pCNit2x2gjY'),
    profileRow(2, 'Clarity', '1mi-gFalmSQ'),
    profileRow(8, 'Dormant', '0YM7Cfp8dIQ', false),
  ],
  memory: [], history: [], studentQuestions: [], stmts: [],
  sessions: [4, 2, 9, 8, 7].map(l => ({ id: sessionOf(l), student_id: STUDENT, lecture_id: l })),
  ...over,
});

// Installs the fake over pool.query + a Gemini tripwire for the duration of fn.
async function inWorld<T>(world: World, fn: () => Promise<T>): Promise<T> {
  const original = pool.query;
  const tripwire = async () => { throw new Error('Gemini provider reached — a pipeline dependency was not injected'); };
  const g = geminiLlmProvider.generate, gs = geminiLlmProvider.generateStream;
  geminiLlmProvider.generate = tripwire;
  geminiLlmProvider.generateStream = tripwire as never;
  let nextId = 5000;

  (pool as unknown as { query: unknown }).query = async (text: string, params: unknown[] = []) => {
    const t = text.replace(/\s+/g, ' ').trim();
    const rec = (kind: string) => world.stmts.push({ kind, text: t, params });
    const ok = (rows: unknown[] = [], rowCount = rows.length) => ({ rows, rowCount });

    if (/^SELECT \* FROM lectures WHERE id = \$1/.test(t)) {
      rec('lecture-load');
      return ok(world.lectures.filter(l => l.id === params[0]));
    }
    if (/FROM lecture_agent_profiles WHERE lecture_id = \$1/.test(t)) {
      rec('profile-load');
      if (world.profileQueryError) throw world.profileQueryError;
      return ok(world.profiles.filter(p => p.lecture_id === params[0]));
    }
    if (/^SELECT 1 AS ok FROM chat_sessions WHERE id = \$1 AND student_id = \$2 AND lecture_id = \$3$/.test(t)) {
      rec('session-validate');
      return ok(world.sessions.filter(x => x.id === params[0] && x.student_id === params[1] && x.lecture_id === params[2]).map(() => ({ ok: 1 })));
    }
    if (/^INSERT INTO student_questions/.test(t)) {
      rec('student-question-insert');
      world.studentQuestions.push({ student_id: params[0] as string, lecture_id: params[1] as number, question: params[2] as string });
      return ok();
    }
    if (/FROM chat_history ch WHERE ch\.session_id = \$1 AND ch\.student_id = \$2/.test(t)) {
      rec('history-load');
      return ok(world.history.filter(h => h.session_id === params[0] && h.student_id === params[1])
        .map(h => ({ ...h, created_at: new Date(), sources_detail: [] })));
    }
    if (/^INSERT INTO chat_history/.test(t)) {
      rec('chat-history-insert');
      const [student_id, lecture_id, question, answer, source_chunk_ids, session_id] = params as [string, number, string, string, number[], number];
      const id = nextId++;
      world.history.push({ id, student_id, lecture_id, session_id, question, answer, source_chunk_ids });
      return ok([{ id }]);
    }
    if (/^UPDATE chat_sessions/.test(t)) { rec('session-touch'); return ok([], 1); }

    // answer memory (real service)
    if (t.includes('string_agg(id::text')) { rec('memory-content-hash'); return ok([{ hash: HASH }]); }
    if (t.includes('FROM rag_answer_memory m') && t.includes('m.normalized_query = $3')) {
      rec('memory-exact-lookup');
      const [s, l, nq, h, em, v] = params as [string, number, string, string, string, string];
      const hit = world.memory.filter(r => r.student_id === s && r.lecture_id === l && r.normalized_query === nq
        && r.lecture_content_hash === h && r.embedding_model_version === em && r.answer_prompt_version === v && r.cache_eligible);
      return ok(hit.slice(0, 1).map(r => ({ id: r.id, answer: r.answer, source_chunk_ids: r.source_chunk_ids })), hit.length);
    }
    if (t.includes('SELECT id FROM rag_answer_memory')) { rec('memory-stale-diagnostic'); return ok(); }
    if (t.includes('FROM lecture_qna_chunks') && t.includes('ANY($2)')) {
      rec('memory-fetch-chunks');
      return ok((params[1] as number[]).map(id => fakeChunk(id, params[0] as number)));
    }
    if (/^INSERT INTO rag_answer_memory/.test(t)) {
      rec('memory-upsert');
      const [s, l, , , , nq, , answer, chunkIds, h, em, v] = params as [string, number, number, string, string, string, string, string, number[], string, string, string];
      const existing = world.memory.find(r => r.student_id === s && r.lecture_id === l && r.normalized_query === nq
        && r.lecture_content_hash === h && r.embedding_model_version === em && r.answer_prompt_version === v);
      if (existing) { existing.answer = answer; existing.source_chunk_ids = chunkIds; }
      else world.memory.push({ id: nextId++, student_id: s, lecture_id: l, normalized_query: nq, lecture_content_hash: h,
        embedding_model_version: em, answer_prompt_version: v, answer, source_chunk_ids: chunkIds, cache_eligible: true, hit_count: 0 });
      return ok([], 1);
    }
    if (/^UPDATE rag_answer_memory SET hit_count/.test(t)) {
      rec('memory-hit-bump');
      const row = world.memory.find(r => r.id === params[0]);
      if (row) row.hit_count++;
      return ok([], 1);
    }
    rec('UNEXPECTED');
    throw new Error(`unexpected SQL: ${t.slice(0, 100)}`);
  };

  try {
    return await fn();
  } finally {
    (pool as unknown as { query: unknown }).query = original;
    geminiLlmProvider.generate = g;
    geminiLlmProvider.generateStream = gs;
  }
}

const fakeChunk = (id: number, lectureId: number, text = `Q: q${id}\nA: a${id}`): QnaChunk => ({
  id, lecture_id: lectureId, topic: 't', question: `q${id}`, answer: `a${id}`, chunk_text: text,
  start_time: null, end_time: null, keywords: null,
});

const verifiedResult = (finalAnswer: string): OutputGuardrailResult => ({
  finalAnswer, verified: true, decision: 'VERIFIED', reason: 'VERIFIED', revisionAttempted: false, revisionSucceeded: false,
  unsupportedClaimCount: 0, missingAspectCount: 0, expectedFormat: 'NATURAL_TEXT', formatValidationRequired: false,
  formatValid: true, formatRepairAttempted: false, formatRepairSucceeded: false, piiDetected: false, piiCategories: [],
});
const fallbackResult = (finalAnswer: string): OutputGuardrailResult => ({
  ...verifiedResult(finalAnswer), verified: false, decision: null, reason: 'VERIFIER_PROVIDER_ERROR',
});

interface Spies {
  order: string[];
  input: string[];
  route: string[];
  search: number[];
  generate: { args: unknown[] }[];
  output: { evidenceTexts: string[]; draftAnswer: string }[];
  greeting: unknown[][];
  summaryChunksFor: number[];
  summaryCalls: number;
  profileLookups: number[];
  traces: FinishedTrace[];
}

function makeDeps(opts: {
  route?: 'FACT_QUESTION' | 'GREETING' | 'LECTURE_SUMMARY' | 'CONTEXTUAL_FOLLOW_UP';
  searchResult?: (lectureId: number) => QnaChunk[];
  inputAction?: 'ALLOW' | 'REJECT';
  outputVerified?: boolean;
  draft?: string;
  extra?: Partial<AskLectureAgentDeps>;
} = {}): { deps: AskLectureAgentDeps; spies: Spies } {
  const spies: Spies = { order: [], input: [], route: [], search: [], generate: [], output: [], greeting: [],
    summaryChunksFor: [], summaryCalls: 0, profileLookups: [], traces: [] };
  const draft = opts.draft ?? 'AGENT DRAFT ANSWER';
  const deps: AskLectureAgentDeps = {
    runInputGuardrails: async q => {
      spies.order.push('input-guardrail'); spies.input.push(q);
      return opts.inputAction === 'REJECT'
        ? { action: 'REJECT', reason: 'PROMPT_INJECTION' }
        : { action: 'ALLOW', sanitizedInput: q };
    },
    classifyRoute: async q => { spies.order.push('route'); spies.route.push(q); return { route: opts.route ?? 'FACT_QUESTION', source: 'rule' }; },
    generateEmbedding: async () => EMB,
    searchChunks: async (_e, lectureId) => { spies.order.push('search'); spies.search.push(lectureId);
      return (opts.searchResult ?? ((l: number) => [fakeChunk(1, l), fakeChunk(2, l)]))(lectureId); },
    rerankChunks: async (_q, c) => c.map(x => ({ ...x, rerankScore: 0.9 })),
    decomposeQuery: async q => ({ mode: 'DIRECT', effectiveQuery: q, subqueries: [], reason: 'NOT_COMPOUND', llmUsed: false }),
    generateAnswer: async (...args: unknown[]) => { spies.order.push('generate'); spies.generate.push({ args }); return draft; },
    runOutputGuardrail: async p => {
      spies.order.push('output-guardrail');
      spies.output.push({ evidenceTexts: p.evidenceTexts, draftAnswer: p.draftAnswer });
      return opts.outputVerified === false ? fallbackResult(LECTURE_NOT_FOUND_MESSAGE) : verifiedResult(`VERIFIED: ${p.draftAnswer}`);
    },
    generateGreeting: async (...args: unknown[]) => { spies.order.push('greeting'); spies.greeting.push(args); return 'Hello from the tutor'; },
    getAllLectureChunks: async lectureId => { spies.summaryChunksFor.push(lectureId); return [fakeChunk(1, lectureId), fakeChunk(2, lectureId)]; },
    generateLectureSummary: async () => { spies.summaryCalls++; return 'LECTURE SUMMARY TEXT'; },
    onTraceComplete: t => { spies.traces.push(t); },
    ...(opts.extra ?? {}),
  };
  return { deps, spies };
}

const ask = (lectureId: number, deps: AskLectureAgentDeps, question = QUESTION) =>
  askLectureAgent({ studentId: STUDENT, lectureId, question, sessionId: sessionOf(lectureId) }, deps);

const rejects = async (p: Promise<unknown>): Promise<unknown> => { try { await p; return null; } catch (e) { return e; } };
const kinds = (w: World) => w.stmts.map(s => s.kind);
const profileArg = (s: Spies, i = 0) => s.generate[i].args[7] as LectureAgentProfile | null | undefined;

// ── A–C: selection ──────────────────────────────────────────────────────

cases.push({
  label: 'A. Nova is selected for lecture_id 4 and reaches generateAnswer',
  run: async () => {
    const w = newWorld(); const { deps, spies } = makeDeps();
    await inWorld(w, () => ask(4, deps));
    const p = profileArg(spies);
    return { pass: spies.generate.length === 1 && p?.agent_name === 'Nova' && p.lecture_id === 4 && p.instructions === INSTRUCTIONS_BY_VIDEO_ID['pCNit2x2gjY'],
      detail: `agent=${p?.agent_name}, lecture=${p?.lecture_id}` };
  },
});

cases.push({
  label: 'B. Clarity is selected for lecture_id 2 (READY lecture simulated by the fake)',
  run: async () => {
    const w = newWorld(); const { deps, spies } = makeDeps();
    await inWorld(w, () => ask(2, deps));
    const p = profileArg(spies);
    return { pass: p?.agent_name === 'Clarity' && p.lecture_id === 2 && p.instructions === INSTRUCTIONS_BY_VIDEO_ID['1mi-gFalmSQ'],
      detail: `agent=${p?.agent_name}` };
  },
});

cases.push({
  label: 'C. Different lectures receive different agents; configurations never mix',
  run: async () => {
    const w = newWorld();
    const a = makeDeps(); const b = makeDeps();
    await inWorld(w, async () => { await ask(4, a.deps); await ask(2, b.deps); });
    const pa = profileArg(a.spies)!, pb = profileArg(b.spies)!;
    const pass = pa.agent_name !== pb.agent_name && pa.instructions !== pb.instructions
      && pa.lecture_id === 4 && pb.lecture_id === 2
      && !pb.instructions.includes('Introductory Lecture') && a.spies.search.every(l => l === 4) && b.spies.search.every(l => l === 2);
    return { pass, detail: `${pa.agent_name}@4, ${pb.agent_name}@2` };
  },
});

// ── D–F: explicit errors, no generic fallback ───────────────────────────

const noSideEffects = (w: World, s: Spies): boolean =>
  s.input.length === 0 && s.route.length === 0 && s.search.length === 0 && s.generate.length === 0 && s.output.length === 0
  && s.greeting.length === 0 && s.summaryCalls === 0
  && w.studentQuestions.length === 0 && w.history.length === 0 && w.memory.length === 0
  && !kinds(w).some(k => ['student-question-insert', 'chat-history-insert', 'session-touch', 'memory-upsert', 'memory-exact-lookup', 'history-load'].includes(k));

cases.push({
  label: 'D. Missing agent profile: explicit application error (503), nothing else executes or is written',
  run: async () => {
    const w = newWorld(); const { deps, spies } = makeDeps();
    const err = await inWorld(w, () => rejects(ask(9, deps)));
    const trace = spies.traces[0] as unknown as { status?: string; attributes?: Record<string, unknown> };
    const pass = err instanceof AppError && err.statusCode === 503 && /not been configured/.test(err.message)
      && noSideEffects(w, spies) && spies.traces.length === 1 && trace.status === 'ERROR';
    return { pass, detail: err instanceof Error ? `${(err as AppError).statusCode}: ${err.message}` : 'no error' };
  },
});

cases.push({
  label: 'E. Inactive agent profile: explicit application error (503), nothing else executes or is written',
  run: async () => {
    const w = newWorld(); const { deps, spies } = makeDeps();
    const err = await inWorld(w, () => rejects(ask(8, deps)));
    const pass = err instanceof AppError && err.statusCode === 503 && /currently unavailable/.test(err.message)
      && noSideEffects(w, spies) && spies.traces.length === 1;
    return { pass, detail: err instanceof Error ? `${(err as AppError).statusCode}: ${err.message}` : 'no error' };
  },
});

cases.push({
  label: 'F. Database failure while loading the profile is never NOT_FOUND and never a generic-tutor answer',
  run: async () => {
    const dbErr = Object.assign(new Error('connection terminated unexpectedly'), { code: '57P01' });
    const w = newWorld({ profileQueryError: dbErr }); const { deps, spies } = makeDeps();
    let value: unknown = 'resolved';
    let thrown: unknown = null;
    await inWorld(w, async () => { try { value = await ask(4, deps); } catch (e) { thrown = e; } });
    const pass = value === 'resolved' && thrown === dbErr && !(thrown instanceof AppError)
      && (thrown as { code?: string }).code === '57P01' && noSideEffects(w, spies) && spies.traces.length === 1;
    return { pass, detail: thrown ? `threw original error (same instance=${thrown === dbErr}, AppError=${thrown instanceof AppError})` : `resolved: ${JSON.stringify(value)}` };
  },
});

// ── G–H: cache version ──────────────────────────────────────────────────

cases.push({
  label: 'G. One effective version is used for memory lookup and write, and it is the agent version (not generic "v1")',
  run: async () => {
    const w = newWorld(); const { deps } = makeDeps();
    await inWorld(w, () => ask(4, deps));
    const lookup = w.stmts.find(s => s.kind === 'memory-exact-lookup')!;
    const upsert = w.stmts.find(s => s.kind === 'memory-upsert')!;
    const expected = getEffectiveAnswerPromptVersion(w.profiles.find(p => p.lecture_id === 4)!);
    const pass = lookup.params[5] === expected && upsert.params[11] === expected && expected !== 'v1' && expected.startsWith('v1+agent:')
      && w.memory.length === 1 && w.memory[0].answer_prompt_version === expected;
    return { pass, detail: `lookup=${String(lookup.params[5]).slice(0, 14)}… write=${String(upsert.params[11]).slice(0, 14)}…` };
  },
});

cases.push({
  label: 'H. An old generic ("v1") cached answer is not returned to an agent request; it stays untouched; the agent answer is then cached and reused',
  run: async () => {
    const generic: MemRow = { id: 79, student_id: STUDENT, lecture_id: 4, normalized_query: 'who is the instructor of this course',
      lecture_content_hash: HASH, embedding_model_version: EMBEDDING_MODEL_VERSION, answer_prompt_version: 'v1',
      answer: 'GENERIC CACHED ANSWER', source_chunk_ids: [1], cache_eligible: true, hit_count: 0 };
    const snapshot = JSON.stringify(generic);
    const w = newWorld({ memory: [generic] });
    const first = makeDeps(); const second = makeDeps();
    const r1 = await inWorld(w, () => ask(4, first.deps));
    const genericAfterFirst = JSON.stringify(w.memory.find(r => r.id === 79));
    const r2 = await inWorld(w, () => ask(4, second.deps));
    const pass = r1.answer !== 'GENERIC CACHED ANSWER' && first.spies.generate.length === 1          // went through generation
      && genericAfterFirst === snapshot && JSON.stringify(w.memory.find(r => r.id === 79)) === snapshot  // legacy row never modified
      && w.memory.length === 2
      && r2.answer === r1.answer && second.spies.generate.length === 0                                  // second ask = agent-version cache hit
      && r2.answer !== 'GENERIC CACHED ANSWER';
    return { pass, detail: `first="${r1.answer}", secondServedFromCache=${second.spies.generate.length === 0}, rows=${w.memory.length}` };
  },
});

// ── I–K: pipeline preserved ─────────────────────────────────────────────

cases.push({
  label: 'I. The exact profile object returned by the selection step is what reaches generateAnswer (and the lecture title is unchanged)',
  run: async () => {
    const w = newWorld();
    const novaObject = profileRow(4, 'Nova', 'pCNit2x2gjY');
    const seam: string[] = [];
    const { deps, spies } = makeDeps({ extra: { getAgentProfile: async id => { seam.push(`lookup:${id}`); return { status: 'FOUND', profile: novaObject }; } } });
    await inWorld(w, () => ask(4, deps));
    const a = spies.generate[0].args;
    const pass = a[7] === novaObject && a[2] === 'Introductory Lecture' && a[0] === QUESTION && seam.join() === 'lookup:4' && a.length === 8;
    return { pass, detail: `seam=${seam.join()}, argCount=${a.length}` };
  },
});

cases.push({
  label: 'J. Retrieval and summary stay lecture-scoped to the requested lecture_id',
  run: async () => {
    const w = newWorld();
    const fact = makeDeps(); const summary = makeDeps({ route: 'LECTURE_SUMMARY' });
    await inWorld(w, async () => { await ask(2, fact.deps); await ask(4, summary.deps, 'Summarize this lecture.'); });
    const lookups = w.stmts.filter(s => s.kind === 'memory-exact-lookup').map(s => s.params[1]);
    const pass = fact.spies.search.length === 1 && fact.spies.search[0] === 2
      && summary.spies.summaryChunksFor.join() === '4' && summary.spies.search.length === 0
      && lookups.every(l => l === 2);
    return { pass, detail: `search=[${fact.spies.search}] summary=[${summary.spies.summaryChunksFor}] memoryLookupLecture=[${lookups}]` };
  },
});

cases.push({
  label: 'K. Guardrails stay active and in order: input guardrail first; output guardrail judges the real draft against the real evidence; its result is what is saved',
  run: async () => {
    const w = newWorld(); const { deps, spies } = makeDeps({ draft: 'DRAFT-XYZ' });
    const res = await inWorld(w, () => ask(4, deps));
    const saved = w.history[0];
    const orderOk = spies.order.join('>') === 'input-guardrail>route>search>generate>output-guardrail';
    const pass = orderOk && spies.output.length === 1 && spies.output[0].draftAnswer === 'DRAFT-XYZ'
      && spies.output[0].evidenceTexts.length === 2 && spies.output[0].evidenceTexts.every(t => t.startsWith('Q: q'))
      && res.answer === 'VERIFIED: DRAFT-XYZ' && saved.answer === 'VERIFIED: DRAFT-XYZ';
    return { pass, detail: spies.order.join('>') };
  },
});

cases.push({
  label: 'K2. Unverified output (conservative fallback) is persisted but never cached; input-guardrail REJECT still blocks before any retrieval',
  run: async () => {
    const w1 = newWorld(); const unverified = makeDeps({ outputVerified: false });
    const r1 = await inWorld(w1, () => ask(4, unverified.deps));
    const w2 = newWorld(); const rejected = makeDeps({ inputAction: 'REJECT' });
    const e2 = await inWorld(w2, () => rejects(ask(4, rejected.deps)));
    const pass = r1.answer === LECTURE_NOT_FOUND_MESSAGE && w1.memory.length === 0 && !kinds(w1).includes('memory-upsert')
      && w1.history[0]?.answer === LECTURE_NOT_FOUND_MESSAGE
      && e2 instanceof AppError && e2.statusCode === 400
      && rejected.spies.search.length === 0 && rejected.spies.generate.length === 0 && w2.history.length === 0 && w2.studentQuestions.length === 0;
    return { pass };
  },
});

// ── L–N: unchanged paths and validation ordering ────────────────────────

cases.push({
  label: 'L. Greeting and summary behave as before (no profile passed to them) while profile validation is enforced first',
  run: async () => {
    const w = newWorld();
    const g = makeDeps({ route: 'GREETING' }); const s = makeDeps({ route: 'LECTURE_SUMMARY' });
    const rg = await inWorld(w, () => ask(4, g.deps, 'hello'));
    const rs = await inWorld(w, () => ask(4, s.deps, 'Summarize this lecture.'));
    const greetingOk = rg.answer === 'Hello from the tutor' && rg.sources.length === 0 && g.spies.greeting.length === 1
      && g.spies.greeting[0][1] === 'Introductory Lecture' && g.spies.search.length === 0 && g.spies.generate.length === 0;
    const summaryOk = rs.answer === 'LECTURE SUMMARY TEXT' && rs.sources.length === 2 && s.spies.summaryCalls === 1
      && s.spies.search.length === 0 && s.spies.generate.length === 0;

    // Same routes on a lecture without a profile: rejected before the greeting/summary generators run.
    const wBad = newWorld();
    const gb = makeDeps({ route: 'GREETING' }); const sb = makeDeps({ route: 'LECTURE_SUMMARY' });
    const eg = await inWorld(wBad, () => rejects(ask(9, gb.deps, 'hello')));
    const es = await inWorld(wBad, () => rejects(ask(9, sb.deps, 'Summarize this lecture.')));
    const enforced = eg instanceof AppError && es instanceof AppError
      && gb.spies.greeting.length === 0 && sb.spies.summaryCalls === 0 && sb.spies.summaryChunksFor.length === 0
      && wBad.history.length === 0;
    return { pass: greetingOk && summaryOk && enforced, detail: `greeting=${greetingOk}, summary=${summaryOk}, enforcedWithoutProfile=${enforced}` };
  },
});

cases.push({
  label: 'M. A non-READY lecture still fails the existing READY check first (400) — the agent profile is never even looked up',
  run: async () => {
    const w = newWorld(); const { deps, spies } = makeDeps({ extra: {} });
    const err = await inWorld(w, () => rejects(ask(7, deps)));
    const pass = err instanceof AppError && err.statusCode === 400 && /not ready/.test(err.message)
      && !kinds(w).includes('profile-load') && noSideEffects(w, spies);
    return { pass, detail: err instanceof Error ? `${(err as AppError).statusCode}: ${err.message}` : 'no error' };
  },
});

cases.push({
  label: 'N. Chat persistence is intact: question logged, history row (student, lecture, question, answer, source ids, session) saved, session touched',
  run: async () => {
    const w = newWorld(); const { deps } = makeDeps();
    const res = await inWorld(w, () => ask(4, deps));
    const h = w.history[0];
    const notFound = makeDeps({ searchResult: () => [] });
    const wNf = newWorld();
    const rNf = await inWorld(wNf, () => ask(4, notFound.deps));
    const pass = w.studentQuestions.length === 1 && w.studentQuestions[0].lecture_id === 4 && w.studentQuestions[0].question === QUESTION
      && w.history.length === 1 && h.student_id === STUDENT && h.lecture_id === 4 && h.session_id === sessionOf(4)
      && h.question === QUESTION && h.answer === res.answer && JSON.stringify(h.source_chunk_ids) === JSON.stringify([1, 2])
      && kinds(w).includes('session-touch') && res.sources.length === 2
      // not-found path unchanged: exact message, no sources, still persisted
      && rNf.answer === LECTURE_NOT_FOUND_MESSAGE && rNf.sources.length === 0
      && wNf.history[0].answer === LECTURE_NOT_FOUND_MESSAGE && wNf.history[0].source_chunk_ids.length === 0
      && notFound.spies.generate.length === 0;
    return { pass };
  },
});

// ── Extra safety / scope checks ─────────────────────────────────────────

cases.push({
  label: 'O. A profile belonging to another lecture is rejected (defence in depth) and never reaches generation',
  run: async () => {
    const w = newWorld();
    const wrong = profileRow(2, 'Clarity', '1mi-gFalmSQ');
    const { deps, spies } = makeDeps({ extra: { getAgentProfile: async () => ({ status: 'FOUND', profile: wrong }) } });
    const err = await inWorld(w, () => rejects(ask(4, deps)));
    return { pass: err instanceof Error && /returned for lecture #4/.test(err.message) && spies.generate.length === 0 && w.history.length === 0, detail: (err as Error)?.message };
  },
});

cases.push({
  label: 'P. Legacy 7-parameter generateAnswer stubs still work (extra profile argument is simply ignored)',
  run: async () => {
    const w = newWorld(); const { deps } = makeDeps();
    // Only the pre-agent 7 parameters are declared; the 8th is ignored.
    const legacy = async (q: string, _c: QnaChunk[], _t: string, _h?: unknown[], _u?: string[], _a?: number, _s?: unknown) => `legacy:${q}`;
    const res = await inWorld(w, () => ask(4, { ...deps, generateAnswer: legacy }));
    return { pass: res.answer === `VERIFIED: legacy:${QUESTION}`, detail: `answer="${res.answer}"` };
  },
});

cases.push({
  label: 'Q. Source check: profile is selected by lectureId only via the profile service seam; no title/number/LLM-based selection',
  run: async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'chat.service.ts'), 'utf8');
    const code = src.replace(/\/\/.*$/gm, '');
    const calls = [...code.matchAll(/getAgentProfile\(([^)]*)\)/g)].map(m => m[1].trim());
    const readyIdx = code.indexOf("lecture.status !== 'READY'");
    const profileIdx = code.indexOf('getAgentProfile(lectureId)');
    const inputIdx = code.indexOf("currentStage = 'input-guardrail'");
    const pass = calls.length === 1 && calls[0] === 'lectureId'
      && readyIdx > 0 && profileIdx > readyIdx && inputIdx > profileIdx
      && !/getAgentProfile\([^)]*(title|youtube|num|agentName)/i.test(code)
      && (code.match(/getEffectiveAnswerPromptVersion\(/g) ?? []).length === 1;
    return { pass, detail: `calls=[${calls}] order ready<profile<input=${readyIdx < profileIdx && profileIdx < inputIdx}` };
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
