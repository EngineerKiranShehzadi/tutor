'use strict';
// Execute actual services offline with injected DB/provider/trace adapters.
// No .env, Neon connections, paid API calls or alternative production logic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
function load(relative, mocks) {
  const filename = path.join(root, relative);
  const built = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, strict: true },
  });
  assert.equal((built.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.require = name => {
    if (Object.prototype.hasOwnProperty.call(mocks, name)) return mocks[name];
    throw new Error(`Offline test blocked an unmocked import: ${name}`);
  };
  mod._compile(built.outputText, filename);
  return mod.exports;
}
function chunk(id, similarity = 0.4, answer = `Answer ${id}`, piece = 0) {
  return { id, lecture_id: 4, topic: null, question: `Question ${id}`, answer,
    chunk_text: `Question: Question ${id}\nAnswer: ${answer}`, chunk_index: piece, similarity };
}
function harness(o = {}) {
  const logs = [], spans = [], sql = [], rerankCalls = [], ftsCalls = [];
  const env = { RETRIEVAL: { VECTOR_SIMILARITY_THRESHOLD: 0.55, RERANK_MIN_SCORE: 0.5,
    HYBRID_SEARCH_ENABLED: o.hybrid !== false, RRF_K: 60, RERANK_PROVIDER: 'voyage' },
    QUERY_DECOMPOSITION: { CONTEXT_PER_SUBQUERY: 3, CONTEXT_MAX_CHUNKS: 10 } };
  const logger = { info: s => logs.push(s), warn: s => logs.push(s) };
  const tracing = { getActiveTrace: () => o.trace === false ? undefined : {
    span: async (name, run, describe) => { const r = await run(); spans.push({ name, ...describe(r) }); return r; },
  } };
  const vector = load('src/services/vector-search.service.ts', {
    '../config/database': { query: async (text, params) => {
      sql.push({ text, params }); if (o.vectorError) throw o.vectorError;
      return { rows: (o.vectorRows || []).slice(0, params[2]), rowCount: null };
    } },
    '../config/env': { env }, '../utils/logger': { logger }, '../observability/tracer': tracing,
    './fulltext-search.service': { searchChunksFts: async (...args) => {
      ftsCalls.push(args); if (o.ftsError) throw o.ftsError;
      return (o.ftsRows || []).slice(0, args[2]);
    } },
  });
  const rerank = load('src/services/rerank.service.ts', {
    '../config/env': { env }, '../utils/logger': { logger },
    '../observability/provider-signal': { tracked: async (_name, run) => run() },
    '../rerank/rerank-provider.resolver': { resolveRerankProvider: () => ({
      modelVersion: 'voyage:rerank-3', rerank: async (question, candidates) => {
        rerankCalls.push({ question, candidates }); if (o.rerankError) throw o.rerankError;
        if (Object.prototype.hasOwnProperty.call(o, 'response')) return o.response;
        return candidates.map(c => ({ id: c.id, score: o.scores?.[c.id] ?? 0.75 }));
      },
    }) },
  });
  const decomposed = load('src/rag/query-processing/retrieval/decomposed-retrieval.service.ts', {
    '../../../services/rerank.service': rerank, '../../../config/env': { env },
    '../../../observability/tracer': tracing, '../../../utils/logger': { logger },
  });
  const deps = { generateEmbedding: async () => [1, 0],
    searchChunks: (e, lecture, limit) => vector.searchChunks(e, lecture, limit, 9),
    rerankChunks: rerank.rerankChunks };
  return { vector, rerank, decomposed, deps, logs, spans, sql, rerankCalls, ftsCalls };
}
// Recorded cosine/rerank scores replay selection; these are not live model tests.
for (const [name, question, cos, scores] of [
  ['outcomes', 'tell me course learning outcomes?', [0.525529, 0.510567], [0.909945, 0.896043]],
  ['typo', 'tell me course leraning outcomes?', [0.479484, 0.467184], [0.906594, 0.891358]],
]) test(`${name}: low-cosine evidence reaches reranker and survives its floor`, async () => {
  const h = harness({ vectorRows: [chunk(19118, cos[0]), chunk(19117, cos[1])],
    scores: { 19118: scores[0], 19117: scores[1] } });
  const c = await h.vector.searchChunksHybrid([1, 0], question, 4, 15, 9);
  assert.deepEqual(c.map(x => x.id), [19118, 19117]);
  const ranked = await h.rerank.rerankChunks(question, c, c.length);
  assert.deepEqual(h.rerank.dedupeAndSelect(ranked).selected.map(x => x.id), [19118, 19117]);
  assert.equal(h.spans.find(s => s.name === 'collect-vector-candidates').belowLegacyVectorFloor, 2);
});
test('technical-skills selection regression with deliberately synthetic scores', async () => {
  const h = harness({ vectorRows: [chunk(18952, 0.42, 'Do it yourself.'),
    chunk(18953, 0.41, 'Doing the task builds confidence and learning from mistakes.')],
    scores: { 18952: 0.9, 18953: 0.8 } });
  const c = await h.vector.searchChunksHybrid([1, 0], 'How do I improve technical skills?', 4, 15, 9);
  const r = await h.rerank.rerankChunks('How do I improve technical skills?', c, c.length);
  assert.deepEqual(h.rerank.dedupeAndSelect(r).selected.map(x => x.id), [18952, 18953]);
});
test('vector-only path also defers cutoff when hybrid is disabled', async () => {
  const h = harness({ hybrid: false, vectorRows: [chunk(1, 0.1)] });
  assert.equal((await h.vector.searchChunksHybrid([1, 0], 'query', 4, 15, 9)).length, 1);
  assert.equal(h.ftsCalls.length, 0);
});
test('SQL preserves lecture, version, non-null vectors and parameterized top-K', async () => {
  const h = harness(); await h.vector.searchChunks([1, 0], 4, 15, 9);
  assert.deepEqual(h.sql[0].params, ['[1,0]', 4, 15, 9]);
  assert.match(h.sql[0].text, /WHERE lecture_id = \$2/);
  assert.match(h.sql[0].text, /version_id = COALESCE\(\$4::int/);
  assert.match(h.sql[0].text, /local_embedding IS NOT NULL/);
  assert.match(h.sql[0].text, /LIMIT \$3/);
  assert.doesNotMatch(h.sql[0].text, /CREATE|UPDATE|DELETE|SET |pg_prewarm/i);
});
test('missing explicit version retains active-version lookup', async () => {
  const h = harness(); await h.vector.searchChunks([1, 0], 4, 15);
  assert.equal(h.sql[0].params[3], null);
  assert.match(h.sql[0].text, /SELECT active_version_id FROM lectures WHERE id = \$2/);
});
test('RRF merges by ID and retains low vectors and lexical-only hits', async () => {
  const h = harness({ vectorRows: [chunk(1, 0.4), chunk(2, 0.3)], ftsRows: [chunk(2), chunk(3)] });
  const c = await h.vector.searchChunksHybrid([1, 0], 'query', 4, 15, 9);
  assert.deepEqual(c.map(x => x.id), [2, 1, 3]); assert.equal(c[0].similarity, 0.3);
  assert.deepEqual(h.ftsCalls[0], ['query', 4, 15, 9]);
});
test('union stays bounded to 2 times per-source topK', async () => {
  const h = harness({ vectorRows: Array.from({ length: 20 }, (_, i) => chunk(i + 1)),
    ftsRows: Array.from({ length: 20 }, (_, i) => chunk(i + 101)) });
  assert.equal((await h.vector.searchChunksHybrid([1, 0], 'query', 4, 15, 9)).length, 30);
});
test('lexical outage safely falls back to vector retrieval, not generation', async () => {
  const h = harness({ vectorRows: [chunk(1)], ftsError: new Error('PRIVATE_ERROR') });
  assert.equal((await h.vector.searchChunksHybrid([1, 0], 'query', 4, 15, 9)).length, 1);
  assert.ok(h.logs.some(s => s.includes('FTS_UNAVAILABLE_VECTOR_ONLY')));
  assert.ok(h.spans.some(s => s.ftsUnavailable === true));
  assert.ok(h.logs.every(s => !s.includes('PRIVATE_ERROR')));
});
test('database failure propagates and is not topic-not-found', async () => {
  const e = new Error('database unavailable'); const h = harness({ vectorError: e });
  await assert.rejects(h.vector.searchChunksHybrid([1, 0], 'query', 4, 15, 9), x => x === e);
});
test('empty candidates skip the reranker', async () => {
  const h = harness(); const c = await h.vector.searchChunks([1, 0], 4, 15, 9);
  assert.deepEqual(await h.rerank.rerankChunks('query', c), []); assert.equal(h.rerankCalls.length, 0);
});
test('reranker relevance floor still rejects insufficient matches', async () => {
  const h = harness({ scores: { 1: 0.49 } });
  const r = await h.rerank.rerankChunks('unsupported', [chunk(1, 0.9)], 1);
  assert.equal(h.rerank.dedupeAndSelect(r).selected.length, 0);
  assert.ok(h.logs.some(s => s.includes('belowFloor=1')));
});
test('reranker outage never forwards raw or cosine-as-rerank candidates', async () => {
  const e = new Error('outage'); const h = harness({ rerankError: e }); let generation = false;
  await assert.rejects((async () => {
    await h.rerank.rerankChunks('query', [chunk(1, 0.99)], 1); generation = true;
  })(), x => x === e);
  assert.equal(generation, false); assert.ok(h.logs.some(s => s.includes('rawFallbackBlocked=true')));
});
for (const [name, response] of [
  ['empty', []], ['partial', [{ id: 1, score: 0.9 }]], ['null array', null],
  ['unknown ID', [{ id: 1, score: 0.9 }, { id: 999, score: 0.8 }]],
  ['duplicate ID', [{ id: 1, score: 0.9 }, { id: 1, score: 0.8 }]],
  ['NaN', [{ id: 1, score: NaN }, { id: 2, score: 0.8 }]],
  ['Infinity', [{ id: 1, score: Infinity }, { id: 2, score: 0.8 }]],
  ['string', [{ id: 1, score: '0.9' }, { id: 2, score: 0.8 }]],
  ['null item', [null, { id: 2, score: 0.8 }]],
]) test(`bad reranker result fails closed: ${name}`, async () => {
  const h = harness({ response });
  await assert.rejects(h.rerank.rerankChunks('query', [chunk(1), chunk(2)], 2), /score set/);
});
test('provider scores are validated and sorted before limiting', async () => {
  const h = harness({ response: [{ id: 1, score: 0.2 }, { id: 2, score: 0.9 }] });
  assert.deepEqual((await h.rerank.rerankChunks('query', [chunk(1), chunk(2)], 1)).map(x => x.id), [2]);
});
test('duplicate candidate IDs fail before any provider request', async () => {
  const h = harness(); await assert.rejects(h.rerank.rerankChunks('query', [chunk(1), chunk(1)]), /Duplicate/);
  assert.equal(h.rerankCalls.length, 0);
});
test('dedup preserves different pieces and backfills up to five', () => {
  const h = harness(); const r = [chunk(1, .4, 'Same'), chunk(2, .4, 'Same'), chunk(3, .4, 'Same', 1),
    chunk(4), chunk(5), chunk(6), chunk(7)].map((c, i) => ({ ...c, rerankScore: .95 - i * .02 }));
  const d = h.rerank.dedupeAndSelect(r);
  assert.deepEqual(d.selected.map(x => x.id), [1, 3, 4, 5, 6]); assert.equal(d.dedupedAway[0].droppedChunk.id, 2);
});
test('absent and non-finite scores cannot pass even a zero floor', () => {
  const h = harness(); assert.equal(h.rerank.dedupeAndSelect([chunk(1),
    { ...chunk(2), rerankScore: NaN }, { ...chunk(3), rerankScore: Infinity }], 5, 0).selected.length, 0);
});
test('decomposed/adaptive shared retrieval recovers low-cosine evidence', async () => {
  const h = harness({ vectorRows: [chunk(19118, .47)], scores: { 19118: .9 } });
  const r = await h.decomposed.retrieveForSubquery(0, 'outcomes', 4, h.deps);
  assert.equal(r.covered, true); assert.equal(r.reranked[0].id, 19118); assert.equal(r.candidateCount, 1);
});
test('failed subquery retains candidate count and becomes unavailable', async () => {
  const h = harness({ vectorRows: [chunk(1)], rerankError: new Error('outage') });
  const r = await h.decomposed.retrieveForSubquery(0, 'query', 4, h.deps);
  assert.equal(r.candidateCount, 1); assert.equal(r.failedStage, 'RERANK'); assert.deepEqual(r.reranked, []);
  assert.deepEqual(h.decomposed.classifyEmptyDecomposedResult([r]), { outcome: 'ERROR', reason: 'RERANKER_FAILURE' });
  assert.deepEqual(h.decomposed.splitUncoveredAspects(['query'], [0], [r]), { notFound: [], unavailable: ['query'] });
});
test('partial outage retains only successfully reranked evidence', async () => {
  const h = harness({ vectorRows: [chunk(1)] });
  const deps = { ...h.deps, rerankChunks: async (q, c, n) => {
    if (q === 'outage') throw new Error('outage'); return h.rerank.rerankChunks(q, c, n);
  } };
  const r = await h.decomposed.retrieveForDecomposedQuery({ lectureId: 4, subqueries: ['good', 'outage'] }, deps);
  assert.deepEqual(r.coveredSubqueryIndexes, [0]); assert.deepEqual(r.uncoveredSubqueryIndexes, [1]);
  assert.deepEqual(r.selectedChunks.map(x => x.id), [1]); assert.equal(r.totalCandidateCount, 2);
});
test('healthy low-relevance response is still NOT_FOUND', async () => {
  const h = harness({ vectorRows: [chunk(1)], scores: { 1: .1 } });
  const r = await h.decomposed.retrieveForSubquery(0, 'unsupported', 4, h.deps);
  assert.deepEqual(h.decomposed.classifyEmptyDecomposedResult([r]),
    { outcome: 'NOT_FOUND', reason: 'ALL_CANDIDATES_BELOW_RERANK_FLOOR' });
});
test('new telemetry exposes counts/reasons but not question/answer/vector content', async () => {
  const h = harness({ vectorRows: [chunk(1, .4, 'PRIVATE_ANSWER')] });
  const c = await h.vector.searchChunksHybrid([.123456789, .987654321], 'PRIVATE_QUESTION', 4, 15, 9);
  h.rerank.dedupeAndSelect(await h.rerank.rerankChunks('PRIVATE_QUESTION', c, c.length));
  assert.doesNotMatch(JSON.stringify({ logs: h.logs, spans: h.spans }), /PRIVATE_ANSWER|PRIVATE_QUESTION|0\.123456789|0\.987654321/);
  assert.ok(h.spans.some(s => s.vectorThresholdApplied === false));
});
test('retrieval works with no active trace', async () => {
  const h = harness({ trace: false, vectorRows: [chunk(1)] });
  assert.equal((await h.vector.searchChunksHybrid([1, 0], 'query', 4, 15, 9)).length, 1); assert.equal(h.spans.length, 0);
});
test('context reorder remains unchanged', () => {
  const h = harness(); assert.deepEqual(h.rerank.reorderForContext([1, 2, 3, 4, 5].map(x => chunk(x))).map(x => x.id), [1, 3, 5, 4, 2]);
});
