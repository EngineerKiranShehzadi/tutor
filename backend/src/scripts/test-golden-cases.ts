/**
 * Golden case bank + RAG benchmark import checks.
 *
 * Pure unit tests: `../config/database` is replaced in the require cache with an
 * in-memory fake BEFORE the services load, so nothing here connects to
 * PostgreSQL and no row is ever read or written.
 *
 * Usage: node_modules/.bin/ts-node --transpile-only src/scripts/test-golden-cases.ts
 */
import { strict as assert } from 'assert';
import Module from 'module';

type Row = Record<string, any>;
const calls: { sql: string; params: unknown[] }[] = [];

// Fake corpus: lecture 2 owns version 8 (chunks 101–103); lecture 4 owns version 16 (chunk 201).
const versions = new Map<number, number>([[8, 2], [16, 4]]);
const versionChunks = new Map<number, Set<number>>([[8, new Set([101, 102, 103])], [16, new Set([201])]]);
const cases = new Map<number, Row>();
let nextId = 1;
const baseRow = (r: Row): Row => ({
  expected_answer: null, source_chunk_ids: [], reviewed_by: null, reviewed_at: null,
  created_at: new Date('2026-11-20T00:00:00Z'), ...r,
});
cases.set(nextId, baseRow({
  id: nextId++, case_key: 'L2-V8-aaaaaaaa', lecture_id: 2, dataset_version_id: 8,
  question: 'What is prompt engineering?', expected_chunk_ids: [101], category: 'factual',
  answerable: true, review_status: 'DRAFT', generation_method: 'DETERMINISTIC_CHUNK',
}));

async function fakeQuery(sql: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
  calls.push({ sql, params });
  const s = sql.replace(/\s+/g, ' ');
  if (s.includes('FROM dataset_versions WHERE id = $1 AND lecture_id = $2')) {
    return { rows: versions.get(params[0] as number) === params[1] ? [{ ok: 1 }] : [] };
  }
  if (s.includes('FROM dataset_version_chunks') && s.includes('ANY($2::int[])')) {
    const set = versionChunks.get(params[0] as number) ?? new Set<number>();
    return { rows: (params[1] as number[]).filter(id => set.has(id)).map(chunk_id => ({ chunk_id })) };
  }
  if (s.startsWith('INSERT INTO golden_benchmark_cases')) {
    const [key, lec, ver, question, answer, expected, category, answerable, method] = params as any[];
    if ([...cases.values()].some(c => c.dataset_version_id === ver && c.case_key === key)) return { rows: [] };
    const row = baseRow({
      id: nextId++, case_key: key, lecture_id: lec, dataset_version_id: ver, question,
      expected_answer: answer, expected_chunk_ids: expected, category, answerable,
      review_status: 'DRAFT', generation_method: method,
    });
    cases.set(row.id, row);
    return { rows: [row] };
  }
  if (s.startsWith('SELECT * FROM golden_benchmark_cases WHERE id = $1')) {
    const r = cases.get(params[0] as number);
    return { rows: r ? [r] : [] };
  }
  if (s.startsWith('UPDATE golden_benchmark_cases')) {
    const [id, status, question, category, answerable, expected, reviewer] = params as any[];
    const r = { ...cases.get(id)!, review_status: status, question, category, answerable,
      expected_chunk_ids: expected, reviewed_by: reviewer, reviewed_at: new Date() };
    cases.set(id, r);
    return { rows: [r] };
  }
  if (s.startsWith('INSERT INTO rag_benchmark_runs')) {
    const [label, , , caseCount, answerable, unsupported, lv, metrics] = params as any[];
    return { rows: [{ id: 1, label, case_count: caseCount, answerable_count: answerable,
      unsupported_count: unsupported, lecture_versions: JSON.parse(lv), metrics: JSON.parse(metrics),
      created_at: new Date() }] };
  }
  throw new Error('Unexpected SQL in fake: ' + s.slice(0, 120));
}

// Prime the require cache so services import the fake, never the real pool.
const dbPath = require.resolve('../config/database');
const fake = new Module(dbPath);
fake.filename = dbPath;
fake.loaded = true;
fake.exports = { query: fakeQuery, default: { end: async () => undefined } };
require.cache[dbPath] = fake;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const golden = require('../services/golden-case.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bench = require('../services/rag-benchmark-report.service');

const status = async (p: Promise<unknown>): Promise<number | 'ok'> => {
  try { await p; return 'ok'; } catch (e: any) { return e?.statusCode ?? -1; }
};

let passed = 0;
const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

// ── Manual cases (the only way to add an unsupported case to the bank) ──
test('createGoldenCase is exported', async () => {
  assert.equal(typeof golden.createGoldenCase, 'function');
});

test('creates an unsupported DRAFT case with no evidence', async () => {
  const c = await golden.createGoldenCase('admin-1', {
    lectureId: 2, datasetVersionId: 8, question: 'What is the capital of France?',
    category: 'unsupported', answerable: false, expectedChunkIds: [],
  });
  assert.equal(c.answerable, false);
  assert.deepEqual(c.expectedChunkIds, []);
  assert.equal(c.reviewStatus, 'DRAFT');
  assert.equal(c.generationMethod, 'MANUAL');
  assert.match(c.caseKey, /^L2-V8-[A-Za-z0-9._-]+$/);
});

test('rejects an unsupported case that carries evidence', async () => {
  assert.equal(await status(golden.createGoldenCase('admin-1', {
    lectureId: 2, datasetVersionId: 8, question: 'Unsupported with evidence?',
    category: 'unsupported', answerable: false, expectedChunkIds: [101],
  })), 400);
});

test('rejects a version that does not belong to the lecture', async () => {
  assert.equal(await status(golden.createGoldenCase('admin-1', {
    lectureId: 2, datasetVersionId: 16, question: 'Wrong lecture/version pair?',
    category: 'factual', answerable: true, expectedChunkIds: [201],
  })), 404);
});

test('rejects evidence chunk IDs outside the pinned version', async () => {
  assert.equal(await status(golden.createGoldenCase('admin-1', {
    lectureId: 2, datasetVersionId: 8, question: 'Evidence from another version?',
    category: 'factual', answerable: true, expectedChunkIds: [101, 201],
  })), 400);
});

test('rejects a duplicate manual question in the same version (409)', async () => {
  const input = { lectureId: 2, datasetVersionId: 8, question: 'Explain few-shot prompting.',
    category: 'conceptual', answerable: true, expectedChunkIds: [102] };
  assert.equal(await status(golden.createGoldenCase('admin-1', input)), 'ok');
  assert.equal(await status(golden.createGoldenCase('admin-1', { ...input, question: '  explain   few-shot prompting. ' })), 409);
});

test('rejects an invalid category', async () => {
  assert.equal(await status(golden.createGoldenCase('admin-1', {
    lectureId: 2, datasetVersionId: 8, question: 'Some valid question?',
    category: 'trivia', answerable: true, expectedChunkIds: [101],
  })), 400);
});

// ── Review: evidence must come from the case's pinned version ──
test('review rejects expected chunk IDs outside the case version', async () => {
  assert.equal(await status(golden.reviewGoldenCase('admin-1', 1, { status: 'APPROVED', expectedChunkIds: [999] })), 400);
  assert.deepEqual(cases.get(1)!.expected_chunk_ids, [101], 'case must be unchanged after a rejected review');
});

test('review accepts in-version evidence and approves', async () => {
  const c = await golden.reviewGoldenCase('admin-1', 1, { status: 'APPROVED', expectedChunkIds: [101, 102] });
  assert.equal(c.reviewStatus, 'APPROVED');
  assert.deepEqual(c.expectedChunkIds, [101, 102]);
});

// ── Dashboard import must accept a realistic captured predictions.json ──
function benchmarkPair(n: number, answerChars: number) {
  const goldCases = Array.from({ length: n }, (_, i) => ({
    id: `L2-V8-c${i}`, lectureId: 2, datasetVersionId: 8, question: `Question number ${i}?`,
    category: i === 0 ? 'unsupported' : 'factual', answerable: i !== 0,
    expectedChunkIds: i === 0 ? [] : [1000 + i], reviewed: true, reviewedBy: 'faculty',
  }));
  const ids = (k: number) => Array.from({ length: k }, (_, j) => 1000 + j * 3);
  const predCases = goldCases.map(c => ({
    id: c.id, lectureId: 2, datasetVersionId: 8, vectorIds: ids(15), hybridIds: ids(25),
    dedupSelectionIds: ids(10), rerankedIds: ids(25), finalContextIds: ids(5), citationChunkIds: ids(5),
    refused: false, latencyMs: 1200, answer: 'x'.repeat(answerChars),
    human: { answerCorrect: 'UNREVIEWED', grounded: 'UNREVIEWED', citationValid: 'UNREVIEWED' },
  }));
  return {
    gold: JSON.stringify({ schemaVersion: 1, cases: goldCases }, null, 2),
    pred: JSON.stringify({ schemaVersion: 1, meta: {}, cases: predCases }, null, 2),
  };
}

test('import accepts a ~900k-char pretty predictions.json (317 cases with --answer)', async () => {
  const { gold, pred } = benchmarkPair(317, 1200);
  assert.ok(pred.length > 400000, `fixture should exceed the old limit (was ${pred.length})`);
  const run = await bench.importRagBenchmark('admin-1', 'Lecture 2 · capture', gold, pred);
  assert.equal(run.caseCount, 317);
  assert.equal(run.unsupported, 1);
});

test('import still rejects absurdly large JSON', async () => {
  assert.equal(await status(bench.importRagBenchmark('admin-1', 'Too big', 'x'.repeat(3_000_001), '{}')), 400);
});

// ── Automatic drafting when a dataset version goes live ──
test('autoDraftGoldenCases drafts the activated lecture/version', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dv = require('../services/dataset-version.service');
  assert.equal(typeof dv.autoDraftGoldenCases, 'function');
  const seen: number[][] = [];
  await dv.autoDraftGoldenCases(2, 17, async (l: number, v: number) => {
    seen.push([l, v]);
    return { datasetVersionId: v, lectureId: l, candidateChunks: 26, created: 26, skipped: 0 };
  });
  assert.deepEqual(seen, [[2, 17]]);
});

test('autoDraftGoldenCases never throws (activation must not fail because of it)', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dv = require('../services/dataset-version.service');
  await dv.autoDraftGoldenCases(2, 17, async () => { throw new Error('relation "golden_benchmark_cases" does not exist'); });
  await dv.autoDraftGoldenCases(2, 17, () => { throw new Error('sync failure'); });
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { console.error(`  FAIL ${name}\n       ${(e as Error).message}`); }
  }
  console.log(`\nGolden case checks: ${passed}/${tests.length} passed.`);
  process.exit(passed === tests.length ? 0 : 1);
})();
