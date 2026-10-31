/**
 * Session isolation / ownership tests for askLectureAgent (Step 7A.1).
 *
 * Fixes under test:
 *  S1 — a session created for lecture A must not be usable for lecture B.
 *  S2 — a student must not be able to use another student's session.
 *
 * Fully mocked: the shared pg pool's `query` is an in-memory fake that models
 * lectures, lecture_agent_profiles, chat_sessions, chat_history and
 * student_questions, and throws on any unknown SQL. Every LLM/network
 * dependency of the pipeline is injected; the LLM provider is a tripwire.
 * Nothing touches the real database.
 *
 * Usage: node_modules/.bin/ts-node --transpile-only src/scripts/test-session-isolation.ts
 */
import pool from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { LectureAgentProfile, QnaChunk } from '../types';
import { askLectureAgent, createChatSession, AskLectureAgentDeps } from '../services/chat.service';
import { openAiLlmProvider } from '../llm/providers/openai-llm.provider';
import { INSTRUCTIONS_BY_VIDEO_ID } from './seed-agent-profiles';
import type { FinishedTrace } from '../observability/types';

interface CaseResult { pass: boolean; detail?: string }
interface Case { label: string; run: () => Promise<CaseResult> }
const cases: Case[] = [];

const STUDENT_A = '11111111-aaaa-aaaa-aaaa-111111111111';
const STUDENT_B = '22222222-bbbb-bbbb-bbbb-222222222222';

interface Hist { id: number; student_id: string; lecture_id: number; session_id: number; question: string; answer: string; source_chunk_ids: number[] }
interface Stmt { kind: string; text: string; params: unknown[] }

const profile = (lectureId: number, name: string, videoId: string): LectureAgentProfile => ({
  lecture_id: lectureId, agent_name: name, instructions: INSTRUCTIONS_BY_VIDEO_ID[videoId], is_active: true,
  created_at: new Date(), updated_at: new Date(),
});

interface World {
  lectures: { id: number; title: string; status: string }[];
  profiles: LectureAgentProfile[];
  sessions: { id: number; student_id: string; lecture_id: number }[];
  history: Hist[];
  studentQuestions: unknown[];
  stmts: Stmt[];
  sessionQueryError?: Error;
  nextSessionId: number;
}

const newWorld = (): World => ({
  lectures: [
    { id: 4, title: 'Introductory Lecture', status: 'READY' },
    { id: 2, title: 'Lecture 2', status: 'READY' },
    { id: 9, title: 'Unconfigured lecture', status: 'READY' },
    { id: 7, title: 'Processing lecture', status: 'PROCESSING' },
  ],
  profiles: [profile(4, 'Nova', 'pCNit2x2gjY'), profile(2, 'Clarity', '1mi-gFalmSQ')],
  sessions: [
    { id: 100, student_id: STUDENT_A, lecture_id: 4 },   // A's session for lecture 4
    { id: 300, student_id: STUDENT_A, lecture_id: 2 },   // A's session for lecture 2
    { id: 200, student_id: STUDENT_B, lecture_id: 4 },   // B's session for lecture 4
  ],
  history: [
    { id: 1, student_id: STUDENT_A, lecture_id: 4, session_id: 100, question: 'L4-QUESTION-TOKEN first', answer: 'L4-ANSWER-TOKEN first', source_chunk_ids: [1] },
    { id: 2, student_id: STUDENT_A, lecture_id: 4, session_id: 100, question: 'L4-QUESTION-TOKEN second', answer: 'L4-ANSWER-TOKEN second', source_chunk_ids: [1] },
    { id: 3, student_id: STUDENT_A, lecture_id: 2, session_id: 300, question: 'L2-QUESTION-TOKEN', answer: 'L2-ANSWER-TOKEN', source_chunk_ids: [1] },
    { id: 4, student_id: STUDENT_B, lecture_id: 4, session_id: 200, question: 'B-PRIVATE-QUESTION', answer: 'B-PRIVATE-ANSWER', source_chunk_ids: [1] },
  ],
  studentQuestions: [], stmts: [], nextSessionId: 5000,
});

async function inWorld<T>(world: World, fn: () => Promise<T>): Promise<T> {
  const original = pool.query;
  const tripwire = async () => { throw new Error('LLM provider reached'); };
  const g = openAiLlmProvider.generate, gs = openAiLlmProvider.generateStream;
  openAiLlmProvider.generate = tripwire;
  openAiLlmProvider.generateStream = tripwire as never;
  let nextId = 9000;
  (pool as unknown as { query: unknown }).query = async (text: string, params: unknown[] = []) => {
    const t = text.replace(/\s+/g, ' ').trim();
    const rec = (kind: string) => world.stmts.push({ kind, text: t, params });
    const ok = (rows: unknown[] = [], rowCount = rows.length) => ({ rows, rowCount });

    // The request pins itself to the lecture's active dataset version once, up front.
    if (t.includes('SELECT active_version_id FROM lectures')) { rec('active-version'); return ok([{ active_version_id: 1 }]); }
    // Dataset readiness gate (getLectureReadiness): not under test here; the fake lecture is fully ready.
    if (/\$1::int IS NULL OR l\.id = \$1/.test(t)) return ok([{ id: params[0], active_version_id: 1, total: '1', missing_embedding: '0', wrong_model: '0' }]);
    if (/^SELECT \* FROM lectures WHERE id = \$1/.test(t)) { rec('lecture-load'); return ok(world.lectures.filter(l => l.id === params[0])); }
    if (/FROM lecture_agent_profiles WHERE lecture_id = \$1/.test(t)) { rec('profile-load'); return ok(world.profiles.filter(p => p.lecture_id === params[0])); }
    if (/^SELECT 1 AS ok FROM chat_sessions WHERE id = \$1 AND student_id = \$2 AND lecture_id = \$3$/.test(t)) {
      rec('session-validate');
      if (world.sessionQueryError) throw world.sessionQueryError;
      return ok(world.sessions.filter(s => s.id === params[0] && s.student_id === params[1] && s.lecture_id === params[2]).map(() => ({ ok: 1 })));
    }
    if (/^INSERT INTO chat_sessions/.test(t)) {
      rec('session-create');
      const row = { id: world.nextSessionId++, student_id: params[0] as string, lecture_id: params[1] as number };
      world.sessions.push(row);
      return ok([{ id: row.id, title: 'New Chat', created_at: new Date(), updated_at: new Date() }]);
    }
    if (/^INSERT INTO student_questions/.test(t)) { rec('student-question-insert'); world.studentQuestions.push(params); return ok(); }
    if (/FROM chat_history ch WHERE ch\.session_id = \$1 AND ch\.student_id = \$2/.test(t)) {
      rec('history-load');
      return ok(world.history.filter(h => h.session_id === params[0] && h.student_id === params[1]).map(h => ({ ...h, created_at: new Date(), sources_detail: [] })));
    }
    if (/^INSERT INTO chat_history/.test(t)) {
      rec('chat-history-insert');
      const [student_id, lecture_id, question, answer, source_chunk_ids, session_id] = params as [string, number, string, string, number[], number];
      const id = nextId++;
      world.history.push({ id, student_id, lecture_id, session_id, question, answer, source_chunk_ids });
      return ok([{ id }]);
    }
    if (/^UPDATE chat_sessions/.test(t)) { rec('session-touch'); return ok([], 1); }
    rec('UNEXPECTED');
    throw new Error(`unexpected SQL: ${t.slice(0, 100)}`);
  };
  try { return await fn(); } finally {
    (pool as unknown as { query: unknown }).query = original;
    openAiLlmProvider.generate = g;
    openAiLlmProvider.generateStream = gs;
  }
}

const chunk = (id: number, lectureId: number): QnaChunk => ({
  id, lecture_id: lectureId, topic: 't', question: `q${id}`, answer: `a${id}`, chunk_text: `Q: q${id}\nA: a${id}`,
  start_time: null, end_time: null, keywords: null,
});

interface Spies {
  input: number; route: number; embed: number; search: number; generate: { history: { question: string; answer: string }[] }[];
  output: number; greeting: number; summaryChunks: number; summaryGen: number; rewrite: number; memLookup: number; memWrite: number;
  traces: FinishedTrace[];
}
function makeDeps(route: 'FACT_QUESTION' | 'GREETING' | 'LECTURE_SUMMARY' | 'CONTEXTUAL_FOLLOW_UP' = 'FACT_QUESTION'): { deps: AskLectureAgentDeps; spies: Spies } {
  const spies: Spies = { input: 0, route: 0, embed: 0, search: 0, generate: [], output: 0, greeting: 0, summaryChunks: 0, summaryGen: 0, rewrite: 0, memLookup: 0, memWrite: 0, traces: [] };
  const deps: AskLectureAgentDeps = {
    runInputGuardrails: async q => { spies.input++; return { action: 'ALLOW', sanitizedInput: q }; },
    classifyRoute: async () => { spies.route++; return { route, source: 'rule' }; },
    resolveRetrievalQuery: async q => { spies.rewrite++; return { query: q, wasRewritten: false, attempted: true }; },
    generateEmbedding: async () => { spies.embed++; return [0.1, 0.2]; },
    searchChunks: async (_e, l) => { spies.search++; return [chunk(1, l)]; },
    rerankChunks: async (_q, c) => c.map(x => ({ ...x, rerankScore: 0.9 })),
    decomposeQuery: async q => ({ mode: 'DIRECT', effectiveQuery: q, subqueries: [], reason: 'NOT_COMPOUND', llmUsed: false }),
    generateAnswer: async (_q, _c, _t, history) => { spies.generate.push({ history: (history ?? []) as { question: string; answer: string }[] }); return 'ANSWER'; },
    runOutputGuardrail: async p => { spies.output++; return {
      finalAnswer: p.draftAnswer, verified: true, decision: 'VERIFIED', reason: 'VERIFIED', revisionAttempted: false, revisionSucceeded: false,
      verificationUnavailable: false, unsupportedClaimCount: 0, missingAspectCount: 0, expectedFormat: 'NATURAL_TEXT', formatValidationRequired: false, formatValid: true,
      formatRepairAttempted: false, formatRepairSucceeded: false, formatRepairRejected: null, piiDetected: false, piiCategories: [] }; },
    lookupAnswerMemory: async () => { spies.memLookup++; return { hit: null, embedding: [0.1, 0.2], datasetVersionId: 1, lookupFailed: false }; },
    writeAnswerMemory: async () => { spies.memWrite++; },
    generateGreeting: async () => { spies.greeting++; return 'hello'; },
    getAllLectureChunks: async l => { spies.summaryChunks++; return [chunk(1, l)]; },
    generateLectureSummary: async () => { spies.summaryGen++; return { summary: 'SUMMARY', batchesAttempted: 1, batchesSucceeded: 1 }; },
    onTraceComplete: t => { spies.traces.push(t); },
  };
  return { deps, spies };
}

const ask = (student: string, lectureId: number, sessionId: number, deps: AskLectureAgentDeps, question = 'Who is the instructor?') =>
  askLectureAgent({ studentId: student, lectureId, question, sessionId }, deps);
const rejects = async (p: Promise<unknown>): Promise<unknown> => { try { await p; return null; } catch (e) { return e; } };

// Nothing but the one validation query may have happened (besides the lecture/profile loads).
const untouched = (w: World, s: Spies): { ok: boolean; why: string } => {
  const forbidden = ['history-load', 'student-question-insert', 'chat-history-insert', 'session-touch', 'session-create'];
  const hitStmt = w.stmts.filter(x => forbidden.includes(x.kind)).map(x => x.kind);
  const spyTotal = s.input + s.route + s.rewrite + s.embed + s.search + s.generate.length + s.output + s.greeting + s.summaryChunks + s.summaryGen + s.memLookup + s.memWrite;
  const ok = hitStmt.length === 0 && spyTotal === 0 && w.studentQuestions.length === 0 && !w.history.some(h => h.id >= 9000);
  return { ok, why: `forbiddenStatements=[${hitStmt}] pipelineCalls=${spyTotal}` };
};

const isRejection = (e: unknown): e is AppError => e instanceof AppError && e.statusCode === 404 && /session not found/i.test(e.message);

// ── A ───────────────────────────────────────────────────────────────────
cases.push({
  label: 'A. Student A uses their own session for the matching lecture: request succeeds and is persisted',
  run: async () => {
    const w = newWorld(); const { deps } = makeDeps();
    const res = await inWorld(w, () => ask(STUDENT_A, 4, 100, deps));
    const saved = w.history.find(h => h.id >= 9000)!;
    const validate = w.stmts.find(s => s.kind === 'session-validate')!;
    const pass = res.answer === 'ANSWER' && saved.session_id === 100 && saved.lecture_id === 4 && saved.student_id === STUDENT_A
      && JSON.stringify(validate.params) === JSON.stringify([100, STUDENT_A, 4])
      && w.stmts.filter(s => s.kind === 'session-validate').length === 1;
    return { pass, detail: `validateParams=${JSON.stringify(validate.params)}` };
  },
});

// ── B ───────────────────────────────────────────────────────────────────
cases.push({
  label: 'B. S1: lecture-4 session used for lecture 2 is rejected before any processing',
  run: async () => {
    const w = newWorld(); const { deps, spies } = makeDeps();
    const err = await inWorld(w, () => rejects(ask(STUDENT_A, 2, 100, deps)));
    const u = untouched(w, spies);
    return { pass: isRejection(err) && u.ok && spies.traces.length === 1, detail: `${(err as Error)?.message} | ${u.why}` };
  },
});

// ── C ───────────────────────────────────────────────────────────────────
cases.push({
  label: 'C. S2: another student\'s session id is rejected before any processing (same lecture, wrong owner)',
  run: async () => {
    const w = newWorld(); const { deps, spies } = makeDeps();
    const err = await inWorld(w, () => rejects(ask(STUDENT_A, 4, 200, deps)));
    const u = untouched(w, spies);
    const bHistoryUntouched = w.history.filter(h => h.session_id === 200).length === 1;
    return { pass: isRejection(err) && u.ok && bHistoryUntouched, detail: `${(err as Error)?.message} | ${u.why}` };
  },
});

// ── D ───────────────────────────────────────────────────────────────────
cases.push({
  label: 'D. A nonexistent session id is rejected before any processing',
  run: async () => {
    const w = newWorld(); const { deps, spies } = makeDeps();
    const err = await inWorld(w, () => rejects(ask(STUDENT_A, 4, 424242, deps)));
    const u = untouched(w, spies);
    return { pass: isRejection(err) && u.ok, detail: u.why };
  },
});

cases.push({
  label: 'D2. Wrong-lecture, wrong-owner and nonexistent sessions are indistinguishable to the caller (no id/ownership disclosure)',
  run: async () => {
    const msgs: string[] = []; const codes: number[] = [];
    for (const [lecture, session] of [[2, 100], [4, 200], [4, 424242]] as const) {
      const w = newWorld(); const { deps } = makeDeps();
      const err = await inWorld(w, () => rejects(ask(STUDENT_A, lecture, session, deps))) as AppError;
      msgs.push(err.message); codes.push(err.statusCode);
    }
    return { pass: new Set(msgs).size === 1 && new Set(codes).size === 1 && codes[0] === 404, detail: `codes=${codes}` };
  },
});

// ── E / F ───────────────────────────────────────────────────────────────
cases.push({
  label: 'E. Valid follow-up: the correct session\'s history (and only that) is loaded, in order',
  run: async () => {
    const w = newWorld(); const { deps, spies } = makeDeps('CONTEXTUAL_FOLLOW_UP');
    await inWorld(w, () => ask(STUDENT_A, 4, 100, deps, 'Why is it necessary?'));
    const h = spies.generate[0]?.history.map(x => x.question);
    const loads = w.stmts.filter(s => s.kind === 'history-load');
    const pass = JSON.stringify(h) === JSON.stringify(['L4-QUESTION-TOKEN first', 'L4-QUESTION-TOKEN second'])
      && loads.length === 1 && loads[0].params[0] === 100 && loads[0].params[1] === STUDENT_A;
    return { pass, detail: JSON.stringify(h) };
  },
});

cases.push({
  label: 'F. Cross-lecture history never reaches generateAnswer: wrong-lecture request is rejected; the lecture\'s own session carries only its own history',
  run: async () => {
    const wBad = newWorld(); const bad = makeDeps();
    await inWorld(wBad, () => rejects(ask(STUDENT_A, 2, 100, bad.deps)));
    const wOk = newWorld(); const ok = makeDeps('CONTEXTUAL_FOLLOW_UP');
    await inWorld(wOk, () => ask(STUDENT_A, 2, 300, ok.deps, 'Why is that?'));
    const questions = ok.spies.generate[0]?.history.map(x => x.question) ?? [];
    const leaks = [...questions, ...(ok.spies.generate[0]?.history.map(x => x.answer) ?? [])].filter(t => /L4-|B-PRIVATE/.test(t));
    return { pass: bad.spies.generate.length === 0 && JSON.stringify(questions) === JSON.stringify(['L2-QUESTION-TOKEN']) && leaks.length === 0,
      detail: `rejectedGenerateCalls=${bad.spies.generate.length}, lecture2History=${JSON.stringify(questions)}` };
  },
});

// ── G / H ───────────────────────────────────────────────────────────────
cases.push({
  label: 'G/H. Invalid sessions write nothing and trigger no retrieval, generation, guardrail or memory activity (all three failure modes)',
  run: async () => {
    const results: string[] = [];
    let allOk = true;
    for (const [label, student, lecture, session] of [['wrong-lecture', STUDENT_A, 2, 100], ['wrong-owner', STUDENT_A, 4, 200], ['nonexistent', STUDENT_A, 4, 7777]] as const) {
      const w = newWorld(); const { deps, spies } = makeDeps();
      const err = await inWorld(w, () => rejects(ask(student, lecture, session, deps)));
      const u = untouched(w, spies);
      const trace = spies.traces[0] as unknown as { status?: string; attributes?: Record<string, unknown> } | undefined;
      const traceOk = spies.traces.length === 1 && trace?.status === 'ERROR';
      const ok = isRejection(err) && u.ok && traceOk
        && !w.stmts.some(s => s.kind.startsWith('memory'))
        && w.history.length === 4;                                   // nothing added
      allOk = allOk && ok;
      results.push(`${label}:${ok ? 'clean' : 'DIRTY(' + u.why + ')'}`);
    }
    return { pass: allOk, detail: results.join(' ') };
  },
});

// ── I ───────────────────────────────────────────────────────────────────
cases.push({
  label: 'I. Greeting, summary, follow-up and fact routes all enforce session validation (invalid session never reaches any of them)',
  run: async () => {
    const out: string[] = [];
    let ok = true;
    for (const route of ['GREETING', 'LECTURE_SUMMARY', 'CONTEXTUAL_FOLLOW_UP', 'FACT_QUESTION'] as const) {
      const w = newWorld(); const { deps, spies } = makeDeps(route);
      const err = await inWorld(w, () => rejects(ask(STUDENT_A, 2, 100, deps, 'hi there')));
      const clean = isRejection(err) && untouched(w, spies).ok && spies.route === 0;
      ok = ok && clean; out.push(`${route}:${clean ? 'rejected' : 'EXECUTED'}`);
    }
    // And the same routes work with a valid session.
    for (const route of ['GREETING', 'LECTURE_SUMMARY'] as const) {
      const w = newWorld(); const { deps } = makeDeps(route);
      const res = await inWorld(w, () => ask(STUDENT_A, 4, 100, deps, 'hello'));
      const good = (route === 'GREETING' ? res.answer === 'hello' : res.answer === 'SUMMARY');
      ok = ok && good; out.push(`${route}(valid):${good ? 'ok' : 'BROKEN'}`);
    }
    return { pass: ok, detail: out.join(' ') };
  },
});

// ── J ───────────────────────────────────────────────────────────────────
cases.push({
  label: 'J. A session created through the real createChatSession workflow is accepted immediately',
  run: async () => {
    const w = newWorld(); const { deps } = makeDeps();
    const res = await inWorld(w, async () => {
      const session = await createChatSession(STUDENT_A, 2);       // real function, fake DB
      return { session, answer: await ask(STUDENT_A, 2, session.id, deps) };
    });
    const pass = res.answer.answer === 'ANSWER' && res.session.id >= 5000
      && w.history.some(h => h.id >= 9000 && h.session_id === res.session.id && h.lecture_id === 2);
    return { pass, detail: `newSession=${res.session.id}` };
  },
});

// ── K ───────────────────────────────────────────────────────────────────
cases.push({
  label: 'K. A database failure during session validation propagates; it is never treated as a valid session or as "not found"',
  run: async () => {
    const dbErr = Object.assign(new Error('connection terminated unexpectedly'), { code: '57P01' });
    const w = newWorld(); w.sessionQueryError = dbErr; const { deps, spies } = makeDeps();
    let value: unknown = 'resolved'; let thrown: unknown = null;
    await inWorld(w, async () => { try { value = await ask(STUDENT_A, 4, 100, deps); } catch (e) { thrown = e; } });
    const u = untouched(w, spies);
    return { pass: value === 'resolved' && thrown === dbErr && !(thrown instanceof AppError) && u.ok && spies.traces.length === 1,
      detail: `sameError=${thrown === dbErr}, isAppError=${thrown instanceof AppError}` };
  },
});

// ── ordering with the earlier gates ─────────────────────────────────────
cases.push({
  label: 'O. Gate order preserved: non-READY (400) first, then missing agent profile (503), then session (404); all before any pipeline work',
  run: async () => {
    const w1 = newWorld(); const a = makeDeps();
    const e1 = await inWorld(w1, () => rejects(ask(STUDENT_A, 7, 424242, a.deps))) as AppError;      // not ready + bad session
    const w2 = newWorld(); const b = makeDeps();
    const e2 = await inWorld(w2, () => rejects(ask(STUDENT_A, 9, 424242, b.deps))) as AppError;      // no profile + bad session
    const w3 = newWorld(); const c = makeDeps();
    const e3 = await inWorld(w3, () => rejects(ask(STUDENT_A, 4, 424242, c.deps))) as AppError;      // ok lecture + bad session
    const pass = e1.statusCode === 400 && e2.statusCode === 503 && e3.statusCode === 404
      && !w1.stmts.some(s => s.kind === 'session-validate') && !w2.stmts.some(s => s.kind === 'session-validate');
    return { pass, detail: `${e1.statusCode} / ${e2.statusCode} / ${e3.statusCode}` };
  },
});

cases.push({
  label: 'P. Unchanged behaviour with a valid session: agent selection, retrieval scope and persistence are as before',
  run: async () => {
    const w = newWorld(); const { deps, spies } = makeDeps();
    let agent = ''; let lectureOfSearch = -1;
    deps.generateAnswer = async (_q, _c, _t, _h, _u, _a, _s, p) => { agent = p?.agent_name ?? ''; return 'ANSWER'; };
    deps.searchChunks = async (_e, l) => { lectureOfSearch = l; return [chunk(1, l)]; };
    const res = await inWorld(w, () => ask(STUDENT_A, 2, 300, deps));
    const kinds = w.stmts.map(s => s.kind);
    const order = kinds.indexOf('lecture-load') < kinds.indexOf('profile-load') && kinds.indexOf('profile-load') < kinds.indexOf('session-validate')
      && kinds.indexOf('session-validate') < kinds.indexOf('student-question-insert');
    return { pass: res.answer === 'ANSWER' && agent === 'Clarity' && lectureOfSearch === 2 && order && spies.output === 1, detail: `agent=${agent}, searchLecture=${lectureOfSearch}, order=${order}` };
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
