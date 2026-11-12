// Runs the actual TypeScript modules with deterministic DB/model substitutes.
// No .env, real API, embedding, quota or production database is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const ROOT = path.resolve(__dirname, '../src');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const response = (status = 200, payload = { candidates: [{ content: { parts: [{ text: '{"questions":[]}' }] }, finishReason: 'STOP' }] }) => ({
  ok: status >= 200 && status < 300, status, json: async () => payload,
});
class AppError extends Error { constructor(message, statusCode) { super(message); this.statusCode = statusCode; } }

function harness(overrides = {}) {
  const logs = [];
  const env = { LLM: { GEMINI: { API_KEY: 'NEVER-LOG-THIS-KEY', QUIZ_MAX_RPM: 10 }, QUIZ: { MODEL: 'gemini-2.5-flash-lite' } } };
  const mocks = new Map([
    [path.join(ROOT, 'middleware/errorHandler'), { AppError }],
    [path.join(ROOT, 'config/env'), { env }],
    [path.join(ROOT, 'utils/logger'), { logger: { info: s => logs.push(s), warn: s => logs.push(s) } }],
    [path.join(ROOT, 'llm/json-schema'), { toJsonSchema: schema => ({ type: schema.type.toLowerCase() }) }],
    [path.join(ROOT, 'config/database'), overrides.database ?? { query: async () => { throw Error('Unexpected DB call'); } }],
    [path.join(ROOT, 'llm/llm-provider.resolver'), { resolveLlmProvider: () => overrides.provider ?? { generate: async () => { throw Error('Unexpected model call'); } } }],
  ]);
  const modules = new Map();
  function load(file) {
    const full = path.resolve(ROOT, file).replace(/\.ts$/, '');
    if (mocks.has(full)) return mocks.get(full);
    if (modules.has(full)) return modules.get(full).exports;
    const mod = { exports: {} };
    modules.set(full, mod);
    const source = fs.readFileSync(full + '.ts', 'utf8');
    const built = ts.transpileModule(source, { fileName: full + '.ts', reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
    const errors = (built.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
    assert.equal(errors.length, 0, JSON.stringify(errors.map(e => ts.flattenDiagnosticMessageText(e.messageText, '\n'))));
    const localRequire = id => id.startsWith('.') ? load(path.resolve(path.dirname(full), id)) : require(id);
    new Function('require', 'module', 'exports', '__filename', '__dirname', built.outputText)(localRequire, mod, mod.exports, full + '.ts', path.dirname(full));
    return mod.exports;
  }
  return { load, logs, env };
}

function source(id = 4) { return { id: 1000 + id, lecture_id: id,
  answer: 'Integrity means acting according to principles in all situations. Practice improves the accuracy of a learned skill.',
  question: 'What does integrity mean?', topic: 'Integrity', start_time: null }; }

function quizHarness(options = {}) {
  const calls = [];
  const queries = [];
  const writes = [];
  let eligibility = 0;
  let nextId = 100;
  let inserted = [];
  let quiz;
  let released = 0;
  let committed = false;
  const requested = options.lectures ?? [4, 6];
  const lectures = requested.map(id => ({ id, title: 'Lecture ' + id, active_version_id: id + 10, status: 'READY' }));
  const database = {
    __esModule: true,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT l.id, l.title')) {
        eligibility++;
        if (options.eligibility) return { rows: options.eligibility(eligibility, lectures) };
        return { rows: lectures };
      }
      if (sql.includes('WITH metadata AS')) {
        if (options.evidence) return { rows: await options.evidence(params) };
        return { rows: [source(params[1])] };
      }
      if (sql.startsWith('SELECT * FROM practice_quizzes WHERE id=')) {
        assert.ok(released > 0, 'save connection must be released before response reload');
        return { rows: [quiz] };
      }
      if (sql.includes('SELECT q.*, l.title')) return { rows: inserted.map((q, i) => ({ ...q, id: String(i + 1), title: 'Lecture ' + q.lecture_id, selected_index: null })) };
      throw Error('Unexpected SQL in mock: ' + sql);
    },
    default: { connect: async () => {
      if (options.connectDelay) await pause(options.connectDelay);
      return {
        release: () => { released++; },
        query: async (sql, params) => {
          writes.push(sql);
          if (options.writeFailure && sql.startsWith('INSERT INTO practice_questions')) throw Error('write failed');
          if (sql.startsWith('INSERT INTO practice_quizzes')) {
            quiz = { id: String(++nextId), student_id: params[0], course_id: params[1], lecture_ids: params[2], question_count: params[3], status: 'IN_PROGRESS', correct_count: null, created_at: new Date(), submitted_at: null };
            return { rows: [{ id: quiz.id }] };
          }
          if (sql.startsWith('INSERT INTO practice_questions')) inserted = JSON.parse(params[1]);
          if (sql === 'COMMIT') committed = true;
          return { rows: [] };
        },
      };
    } },
  };
  const generationByLecture = new Map();
  let verifyCall = 0;
  const provider = { generate: async req => {
    calls.push(req);
    if (options.provider) return options.provider(req, calls);
    if (req.telemetry.operation === 'QUIZ_VERIFY') {
      verifyCall++;
      const body = JSON.parse(req.userPrompt);
      const checks = body.questions.map(q => ({ index: q.index, grounded: true, unambiguous: true }));
      if (options.verification) return options.verification(body, verifyCall, checks);
      return { raw: JSON.stringify({ checks }), finishReason: 'STOP' };
    }
    const id = Number(req.userPrompt.match(/Lecture ID: (\d+)/)[1]);
    const attempt = (generationByLecture.get(id) ?? 0) + 1;
    generationByLecture.set(id, attempt);
    const categories = req.userPrompt.match(/Categories in question order: ([A-Z, ]+)\./)[1].split(', ');
    const questions = categories.map((category, i) => ({ lectureId: id, sourceId: source(id).id, category,
      question: `For lecture ${id} practice ${attempt} item ${i}, what does integrity require?`,
      options: ['Consistent principles', 'Random choices', 'Ignoring values', 'Cheating'], correctIndex: 0,
      explanation: 'The source requires consistent principles in all situations.', evidenceQuote: source(id).answer.split('. ')[0] + '.' }));
    if (options.generation) return options.generation(questions, id, attempt, req);
    return { raw: JSON.stringify({ questions }), finishReason: 'STOP' };
  } };
  const h = harness({ database, provider });
  const svc = h.load('services/practice-quiz.service');
  return { ...h, svc, calls, queries, writes, get released() { return released; }, get committed() { return committed; } };
}

// Queue: cancelled requests do not use up future rate-limit slots.
test('queue grants an idle slot immediately', async () => {
  const { GeminiRequestQueue } = harness().load('llm/providers/gemini-request-queue');
  assert.ok(await new GeminiRequestQueue(() => 1, 20).acquire() >= 0);
});
test('queue respects the RPM window', async () => {
  const { GeminiRequestQueue } = harness().load('llm/providers/gemini-request-queue');
  const queue = new GeminiRequestQueue(() => 1, 25);
  await queue.acquire();
  assert.ok(await queue.acquire(undefined, 100) >= 20);
});
test('cancelling queued work removes it without a phantom reservation', async () => {
  const { GeminiRequestQueue } = harness().load('llm/providers/gemini-request-queue');
  const queue = new GeminiRequestQueue(() => 1, 35);
  await queue.acquire();
  const controller = new AbortController();
  const cancelled = queue.acquire(controller.signal, 200);
  controller.abort(new Error('cancel test'));
  await assert.rejects(cancelled, /cancel test/);
  const start = Date.now();
  await queue.acquire(undefined, 80);
  assert.ok(Date.now() - start < 70, 'no extra window charged for cancelled work');
});
test('queue wait timeout rejects before a request is dispatched', async () => {
  const { GeminiRequestQueue } = harness().load('llm/providers/gemini-request-queue');
  const queue = new GeminiRequestQueue(() => 1, 100);
  await queue.acquire();
  await assert.rejects(queue.acquire(undefined, 5), e => e.code === 'QUEUE_TIMEOUT');
});
test('queue rejects already cancelled work and invalid limits', () => {
  const { GeminiRequestQueue } = harness().load('llm/providers/gemini-request-queue');
  const c = new AbortController(); c.abort(Error('already cancelled'));
  assert.throws(() => new GeminiRequestQueue(() => 1).acquire(c.signal), /already cancelled/);
  assert.throws(() => new GeminiRequestQueue(() => 0).acquire(), /Invalid/);
});
test('queue has bounded pending capacity', async () => {
  const { GeminiRequestQueue } = harness().load('llm/providers/gemini-request-queue');
  const queue = new GeminiRequestQueue(() => 1, 1000);
  await queue.acquire();
  const c = new AbortController();
  const waiting = Array.from({ length: 3 }, () => queue.acquire(c.signal).catch(e => e));
  await assert.rejects(queue.acquire(), e => e.code === 'QUEUE_FULL');
  c.abort(Error('cleanup')); await Promise.all(waiting);
});

test('provider response timer excludes queue waiting', async () => {
  const h = harness();
  const { createGeminiLlmProvider } = h.load('llm/providers/gemini-llm.provider');
  const provider = createGeminiLlmProvider({ queue: { acquire: async () => { await pause(40); return 40; } },
    fetch: async (_url, init) => { assert.equal(init.signal.aborted, false); await pause(5); assert.equal(init.signal.aborted, false); return response(); } });
  assert.equal((await provider.generate({ model: 'test', userPrompt: 'not logged', timeoutMs: 25 })).raw, '{"questions":[]}');
});
test('provider parent cancellation while queued makes no network call', async () => {
  const h = harness(); const { abortableSleep } = h.load('utils/abortable');
  const { createGeminiLlmProvider } = h.load('llm/providers/gemini-llm.provider');
  let sent = 0;
  const provider = createGeminiLlmProvider({ queue: { acquire: async signal => { await abortableSleep(1000, signal); return 1000; } },
    fetch: async () => { sent++; return response(); } });
  const c = new AbortController();
  const promise = provider.generate({ model: 'test', userPrompt: 'hidden', signal: c.signal });
  c.abort(Error('parent deadline'));
  await assert.rejects(promise, /parent deadline/); assert.equal(sent, 0);
});
test('provider network timeout aborts HTTP and has a distinct code', async () => {
  const h = harness(); const { abortableSleep } = h.load('utils/abortable');
  const { createGeminiLlmProvider } = h.load('llm/providers/gemini-llm.provider');
  const provider = createGeminiLlmProvider({ queue: { acquire: async () => 0 },
    fetch: async (_url, init) => { await abortableSleep(1000, init.signal); return response(); } });
  await assert.rejects(provider.generate({ model: 'test', userPrompt: 'hidden', timeoutMs: 5 }), e => e.code === 'MODEL_TIMEOUT');
});
for (const [status, code] of [[429, 'RATE_LIMIT'], [401, 'MODEL_ACCESS'], [403, 'MODEL_ACCESS'], [404, 'MODEL_NOT_FOUND']]) {
  test(`provider reports HTTP ${status} without retry`, async () => {
    const h = harness(); const { createGeminiLlmProvider } = h.load('llm/providers/gemini-llm.provider');
    let calls = 0;
    const provider = createGeminiLlmProvider({ queue: { acquire: async () => 0 }, fetch: async () => { calls++; return response(status); } });
    await assert.rejects(provider.generate({ model: 'test', userPrompt: 'hidden' }), e => e.code === code);
    assert.equal(calls, 1);
  });
}
test('provider retries 503 once and cancels retries on deadline', async () => {
  const h = harness(); const { createGeminiLlmProvider } = h.load('llm/providers/gemini-llm.provider');
  let calls = 0;
  const provider = createGeminiLlmProvider({ queue: { acquire: async () => 0 }, retryDelayMs: 1,
    fetch: async () => { calls++; return response(calls === 1 ? 503 : 200); } });
  assert.ok(await provider.generate({ model: 'test', userPrompt: 'hidden' })); assert.equal(calls, 2);
  const c = new AbortController(); let sent = 0;
  const cancelled = createGeminiLlmProvider({ queue: { acquire: async () => 0 }, retryDelayMs: 100,
    fetch: async () => { sent++; setTimeout(() => c.abort(Error('deadline')), 1); return response(503); } });
  await assert.rejects(cancelled.generate({ model: 'test', userPrompt: 'hidden', signal: c.signal }), /deadline/);
  assert.equal(sent, 1);
});
test('provider permanent overload stops after two requests', async () => {
  const { createGeminiLlmProvider } = harness().load('llm/providers/gemini-llm.provider'); let calls = 0;
  const provider = createGeminiLlmProvider({ queue: { acquire: async () => 0 }, retryDelayMs: 1,
    fetch: async () => { calls++; return response(503); } });
  await assert.rejects(provider.generate({ model: 'test', userPrompt: 'hidden' }), e => e.code === 'MODEL_OVERLOADED');
  assert.equal(calls, 2);
});
test('provider distinguishes unreadable responses from network failures and redacts logs', async () => {
  const h = harness(); const { createGeminiLlmProvider } = h.load('llm/providers/gemini-llm.provider');
  const base = { queue: { acquire: async () => 0 } };
  await assert.rejects(createGeminiLlmProvider({ ...base, fetch: async () => { throw Error('NEVER-LOG-THIS-KEY'); } })
    .generate({ model: 'test', userPrompt: 'PRIVATE-LECTURE-TEXT' }), e => e.code === 'NETWORK_FAILURE');
  await assert.rejects(createGeminiLlmProvider({ ...base, fetch: async () => ({ ok: true, json: async () => { throw SyntaxError('bad JSON'); } }) })
    .generate({ model: 'test', userPrompt: 'PRIVATE-LECTURE-TEXT' }), e => e.code === 'INVALID_RESPONSE');
  assert.doesNotMatch(h.logs.join('\n'), /NEVER-LOG-THIS-KEY|PRIVATE-LECTURE-TEXT/);
});
test('provider preserves structured output, thinking-off mapping and usage', async () => {
  const { createGeminiLlmProvider } = harness().load('llm/providers/gemini-llm.provider'); let body;
  const provider = createGeminiLlmProvider({ queue: { acquire: async () => 0 }, fetch: async (_url, init) => {
    body = JSON.parse(init.body); return response(200, { candidates: [{ content: { parts: [{ thought: true, text: 'private reasoning' }, { text: '{"ok":true}' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 20 } });
  } });
  const result = await provider.generate({ model: 'gemini-2.5-flash-lite', userPrompt: 'test', thinking: 'off', responseSchema: { type: 'OBJECT' } });
  assert.equal(body.generationConfig.responseMimeType, 'application/json'); assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.equal(result.raw, '{"ok":true}'); assert.equal(result.usage.totalTokens, 20);
});

test('two lectures use two generation calls plus one combined verifier', async () => {
  const h = quizHarness(); const result = await h.svc.createPracticeQuiz('student', 1, [4, 6]);
  assert.equal(result.total, 10); assert.equal(h.calls.length, 3); assert.equal(h.committed, true);
  const verify = h.calls.filter(c => c.telemetry.operation === 'QUIZ_VERIFY');
  assert.equal(verify.length, 1); assert.equal(JSON.parse(verify[0].userPrompt).questions.length, 10);
  assert.equal(JSON.parse(verify[0].userPrompt).sources.length, 2);
  assert.ok(result.questions.every(q => q.correctIndex === null && q.explanation === null));
  assert.ok(h.logs.some(l => l.startsWith('[QUIZ-TOTAL]')));
});
test('source packs are reused but every explicit click generates a new quiz', async () => {
  const h = quizHarness();
  const first = await h.svc.createPracticeQuiz('student', 1, [4, 6]);
  const second = await h.svc.createPracticeQuiz('student', 1, [4, 6]);
  assert.notEqual(first.id, second.id); assert.equal(h.calls.length, 6);
  assert.equal(h.queries.filter(q => q.sql.includes('WITH metadata')).length, 2);
  assert.equal(h.queries.filter(q => q.sql.includes('SELECT l.id, l.title')).length, 4);
  assert.ok(h.logs.some(l => l.includes('cacheHit=true')));
});
test('one failed question is replaced without regenerating approved questions', async () => {
  const h = quizHarness({ verification: (body, count, checks) => {
    if (count === 1) checks[0].grounded = false;
    return { raw: JSON.stringify({ checks }), finishReason: 'STOP' };
  } });
  const quiz = await h.svc.createPracticeQuiz('student', 1, [4, 6]); assert.equal(quiz.total, 10);
  const gen = h.calls.filter(c => c.telemetry.operation === 'QUIZ_GENERATE');
  assert.equal(gen.length, 3); assert.match(gen[2].userPrompt, /EXACTLY 1 NEW/);
  assert.match(gen[2].userPrompt, /Do not repeat these accepted/);
  const verify = h.calls.filter(c => c.telemetry.operation === 'QUIZ_VERIFY');
  assert.deepEqual(verify.map(v => JSON.parse(v.userPrompt).questions.length), [10, 1]);
});
test('invalid verifier output fails closed and never saves an unverified quiz', async () => {
  const h = quizHarness({ verification: () => ({ raw: '{"checks":[]}', finishReason: 'STOP' }) });
  await assert.rejects(h.svc.createPracticeQuiz('student', 1, [4, 6]), /enough grounded/);
  assert.equal(h.writes.length, 0); assert.equal(h.calls.length, 6);
});
test('invented evidence is dropped before verification', async () => {
  const h = quizHarness({ generation: questions => ({ raw: JSON.stringify({ questions: questions.map(q => ({ ...q, evidenceQuote: 'Invented evidence not present in this lecture.' })) }) }) });
  await assert.rejects(h.svc.createPracticeQuiz('student', 1, [4, 6]), /enough grounded/);
  assert.equal(h.calls.filter(c => c.telemetry.operation === 'QUIZ_VERIFY').length, 0); assert.equal(h.writes.length, 0);
});
test('versions are pinned and a changed active version stops saving', async () => {
  const h = quizHarness({ eligibility: (call, lectures) => call === 1 ? lectures : lectures.map(l => ({ ...l, active_version_id: l.active_version_id + 1 })) });
  await assert.rejects(h.svc.createPracticeQuiz('student', 1, [4, 6]), /material changed/);
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.queries.filter(q => q.sql.includes('WITH metadata')).map(q => q.params.slice(0, 3)), [[1, 4, 14], [1, 6, 16]]);
});
test('missing or archived lectures are rejected before any model call', async () => {
  const h = quizHarness({ eligibility: () => [] });
  await assert.rejects(h.svc.createPracticeQuiz('student', 1, [4, 6]), /ready learning material/);
  assert.equal(h.calls.length, 0); assert.match(h.queries[0].sql, /l.archived_at IS NULL AND c.archived_at IS NULL/);
});
test('a failed parallel generation aborts its sibling and does not save', async () => {
  let siblingCancelled = false;
  const h = quizHarness({ provider: async req => {
    if (req.userPrompt.startsWith('Lecture ID: 4')) { await pause(5); throw Error('provider unavailable'); }
    await new Promise((resolve, reject) => req.signal.addEventListener('abort', () => { siblingCancelled = true; reject(req.signal.reason); }, { once: true }));
    throw Error('unreachable');
  } });
  await assert.rejects(h.svc.createPracticeQuiz('student', 1, [4, 6]), /provider unavailable/);
  await pause(2); assert.equal(siblingCancelled, true); assert.equal(h.writes.length, 0); assert.equal(h.calls.length, 2);
});
test('overall deadline cancels generation and clears duplicate-request guard', async () => {
  process.env.QUIZ_GENERATION_TIMEOUT_MS = '15';
  try {
    const h = quizHarness({ provider: req => new Promise((resolve, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true })) });
    const first = h.svc.createPracticeQuiz('student', 1, [4, 6]);
    await assert.rejects(h.svc.createPracticeQuiz('student', 1, [4, 6]), /already being generated/);
    await assert.rejects(first, e => e.code === 'QUIZ_DEADLINE');
    await assert.rejects(h.svc.createPracticeQuiz('student', 1, [4, 6]), e => e.code === 'QUIZ_DEADLINE');
    assert.equal(h.writes.length, 0);
  } finally { delete process.env.QUIZ_GENERATION_TIMEOUT_MS; }
});
test('a connection acquired after expiry is released and never used to insert', async () => {
  process.env.QUIZ_GENERATION_TIMEOUT_MS = '15';
  try {
    const h = quizHarness({ connectDelay: 35 });
    await assert.rejects(h.svc.createPracticeQuiz('student', 1, [4, 6]), e => e.code === 'QUIZ_DEADLINE');
    await pause(40); assert.equal(h.released, 1); assert.equal(h.writes.length, 0);
  } finally { delete process.env.QUIZ_GENERATION_TIMEOUT_MS; }
});
test('atomic save rolls back if inserting quiz questions fails', async () => {
  const h = quizHarness({ writeFailure: true });
  await assert.rejects(h.svc.createPracticeQuiz('student', 1, [4, 6]), /write failed/);
  assert.equal(h.committed, false); assert.ok(h.writes.includes('ROLLBACK')); assert.equal(h.released, 1);
});
test('larger quizzes keep lecture coverage and verifier batches bounded', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => i + 1); const h = quizHarness({ lectures: ids });
  const quiz = await h.svc.createPracticeQuiz('student', 1, ids);
  assert.equal(quiz.total, 12); assert.deepEqual(quiz.lectureIds, ids);
  const lengths = h.calls.filter(c => c.telemetry.operation === 'QUIZ_VERIFY').map(c => JSON.parse(c.userPrompt).questions.length);
  assert.deepEqual(lengths, [10, 2]);
});
test('module loading performs no automatic quiz generation', () => {
  const h = quizHarness(); assert.equal(h.calls.length, 0); assert.equal(h.queries.length, 0); assert.equal(h.writes.length, 0);
});

test('compact evidence is bounded and never paraphrases the source', () => {
  const { compactSources } = harness().load('services/quiz-evidence.service');
  const rows = Array.from({ length: 20 }, (_, i) => ({ ...source(i), answer: ('A complete factual statement about this course. ').repeat(200) }));
  const pack = compactSources(rows); assert.equal(pack.length, 14);
  assert.ok(pack.reduce((sum, s) => sum + s.answer.length, 0) <= 6000);
  assert.ok(pack.every((s, i) => rows[i].answer.includes(s.answer)));
});
test('source cache keys separate course, lecture and dataset version', async () => {
  const calls = []; const h = harness({ database: { query: async (_sql, params) => { calls.push(params); return { rows: [source(params[1])] }; } } });
  const { loadQuizEvidence } = h.load('services/quiz-evidence.service');
  await loadQuizEvidence(1, 4, 9); await loadQuizEvidence(1, 4, 9);
  await loadQuizEvidence(1, 4, 10); await loadQuizEvidence(2, 4, 10);
  assert.equal(calls.length, 3);
});
test('concurrent source requests share one load without sharing generated quizzes', async () => {
  let calls = 0; const h = harness({ database: { query: async () => { calls++; await pause(5); return { rows: [source()] }; } } });
  const { loadQuizEvidence } = h.load('services/quiz-evidence.service');
  const [a, b] = await Promise.all([loadQuizEvidence(1, 4, 9), loadQuizEvidence(1, 4, 9)]);
  assert.equal(calls, 1); assert.equal(b.sharedLoad, true); a.sources[0].answer = 'changed';
  assert.notEqual((await loadQuizEvidence(1, 4, 9)).sources[0].answer, 'changed');
});
test('source cache TTL and LRU bounds work', async () => {
  process.env.QUIZ_EVIDENCE_CACHE_TTL_MS = '15'; process.env.QUIZ_EVIDENCE_CACHE_MAX_ENTRIES = '1';
  try {
    let calls = 0; const h = harness({ database: { query: async (_sql, params) => { calls++; return { rows: [source(params[1])] }; } } });
    const { loadQuizEvidence } = h.load('services/quiz-evidence.service');
    await loadQuizEvidence(1, 4, 9); await loadQuizEvidence(1, 5, 9); await loadQuizEvidence(1, 4, 9);
    assert.equal(calls, 3); await pause(20); await loadQuizEvidence(1, 4, 9); assert.equal(calls, 4);
  } finally { delete process.env.QUIZ_EVIDENCE_CACHE_TTL_MS; delete process.env.QUIZ_EVIDENCE_CACHE_MAX_ENTRIES; }
});
test('failed evidence loads are not cached and can retry', async () => {
  let calls = 0; const h = harness({ database: { query: async () => { if (++calls === 1) throw Error('DB offline'); return { rows: [source()] }; } } });
  const { loadQuizEvidence } = h.load('services/quiz-evidence.service');
  await assert.rejects(loadQuizEvidence(1, 4, 9), /DB offline/);
  assert.equal((await loadQuizEvidence(1, 4, 9)).sources.length, 1); assert.equal(calls, 2);
});

test('source SQL executes with bounded, version-scoped sampling in disposable PostgreSQL', { skip: !process.env.QUIZ_TEST_DATABASE_URL }, async () => {
  const url = new URL(process.env.QUIZ_TEST_DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/quiz_latency_test', 'Disposable local DB only');
  const { Client } = require('pg'); const client = new Client({ connectionString: url.toString() }); await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE lectures(id int PRIMARY KEY, course_id int)');
    await client.query('CREATE TEMP TABLE lecture_qna_chunks(id int PRIMARY KEY, lecture_id int, topic text, chunk_text text, question text, start_time text)');
    await client.query('CREATE TEMP TABLE dataset_version_chunks(version_id int, chunk_id int, qa_id int, chunk_index int)');
    await client.query('INSERT INTO lectures VALUES (4,1),(5,2)');
    for (let i = 1; i <= 30; i++) {
      await client.query('INSERT INTO lecture_qna_chunks VALUES ($1,$2,$3,$4,$5,NULL)', [i, i < 30 ? 4 : 5, i % 3 ? null : 'Topic ' + i, 'Source content. '.repeat(200), 'Question ' + i]);
      await client.query('INSERT INTO dataset_version_chunks VALUES ($1,$2,$2,0)', [i <= 28 ? 9 : 8, i]);
    }
    const { QUIZ_EVIDENCE_SQL } = harness().load('services/quiz-evidence.service');
    const { rows } = await client.query(QUIZ_EVIDENCE_SQL, [1, 4, 9, 14]);
    assert.equal(rows.length, 14); assert.ok(rows.every(r => r.lecture_id === 4 && r.id <= 28 && r.answer.length <= 1800));
    assert.equal(new Set(rows.map(r => Math.floor((r.id - 1) / 2))).size, 14);
    assert.equal((await client.query(QUIZ_EVIDENCE_SQL, [2, 4, 9, 14])).rows.length, 0);
    assert.deepEqual((await client.query(QUIZ_EVIDENCE_SQL, [1, 4, 8, 14])).rows.map(r => r.id), [29]);
  } finally { await client.query('ROLLBACK'); await client.end(); }
});
