'use strict';
// Offline unit tests for the deterministic RAG golden evaluator. No database,
// no network — it takes a gold document and a predictions document and returns
// retrieval / citation / refusal / human metrics, with strict input validation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('./golden-evaluator.cjs');

// --- fixture builders -------------------------------------------------------
function goldCase(over = {}) {
  return {
    id: 'c1', lectureId: 4, datasetVersionId: 2,
    question: 'What does integrity mean in professional ethics?',
    category: 'factual', answerable: true,
    reviewed: true, reviewedBy: 'faculty-a',
    expectedChunkIds: [10, 20],
    ...over,
  };
}
function predCase(over = {}) {
  return {
    id: 'c1', lectureId: 4, datasetVersionId: 2,
    vectorIds: [99, 10, 20], hybridIds: [10, 20], rerankedIds: [10, 20],
    finalContextIds: [10, 20], citationChunkIds: [10, 30],
    refused: false, latencyMs: 120,
    human: { answerCorrect: 'PASS', grounded: 'PASS', citationValid: 'PASS' },
    ...over,
  };
}
// A valid two-case dataset: one answerable, one unsupported-and-correctly-refused.
function dataset() {
  const gold = {
    schemaVersion: 1,
    cases: [
      goldCase(),
      goldCase({ id: 'c2', category: 'unsupported', answerable: false, expectedChunkIds: [] }),
    ],
  };
  const pred = {
    schemaVersion: 1,
    cases: [
      predCase(),
      predCase({
        id: 'c2', vectorIds: [], hybridIds: [], rerankedIds: [],
        finalContextIds: [], citationChunkIds: [], refused: true, latencyMs: 340,
        human: { answerCorrect: 'UNREVIEWED', grounded: 'UNREVIEWED', citationValid: 'UNREVIEWED' },
      }),
    ],
  };
  return { gold, pred };
}

// --- metric computation -----------------------------------------------------
test('reports case counts and answerability split', () => {
  const r = evaluate(...Object.values(dataset()));
  assert.equal(r.caseCount, 2);
  assert.equal(r.answerable, 1);
  assert.equal(r.unsupported, 1);
  assert.deepEqual(r.lectureVersions, ['4:2']);
});

test('computes recall@5 and MRR from the predicted ranking', () => {
  const r = evaluate(...Object.values(dataset()));
  // vector ranking [99,10,20] vs expected {10,20}: both found in top-5, first hit at rank 2.
  assert.equal(r.retrieval.vector.count, 1);
  assert.equal(r.retrieval.vector.recallAt5, 1);
  assert.equal(r.retrieval.vector.mrr, 0.5);
  // hybrid ranking [10,20] puts a hit first.
  assert.equal(r.retrieval.hybrid.mrr, 1);
});

test('omits the optional dedupSelection stage when predictions do not carry it', () => {
  const r = evaluate(...Object.values(dataset()));
  assert.equal('dedupSelection' in r.retrieval, false, 'absent dedupSelectionIds must not add a stage (back-compat)');
});

test('scores the optional dedupSelection stage when every prediction carries it', () => {
  const { gold, pred } = dataset();
  // Add the post-dedup stage to BOTH predictions (answerable + unsupported).
  pred.cases[0].dedupSelectionIds = [10, 20]; // perfect post-dedup ordering
  pred.cases[1].dedupSelectionIds = [];        // unsupported: no evidence
  const r = evaluate(gold, pred);
  assert.ok(r.retrieval.dedupSelection, 'dedupSelection stage should be scored');
  assert.equal(r.retrieval.dedupSelection.recallAt5, 1);
  assert.equal(r.retrieval.dedupSelection.mrr, 1);
  // Existing stages are unaffected.
  assert.equal(r.retrieval.vector.mrr, 0.5);
});

test('rejects a malformed dedupSelectionIds when present', () => {
  const { gold, pred } = dataset();
  pred.cases[0].dedupSelectionIds = [10, 10]; // duplicate ids
  assert.throws(() => evaluate(gold, pred), /dedupSelectionIds: duplicates/);
});

test('computes citation precision and recall', () => {
  const r = evaluate(...Object.values(dataset()));
  // citations [10,30] vs expected {10,20}: 1 correct of 2 predicted, of 2 expected.
  assert.equal(r.citations.precision, 0.5);
  assert.equal(r.citations.recall, 0.5);
});

test('computes refusal rates for supported vs unsupported cases', () => {
  const r = evaluate(...Object.values(dataset()));
  assert.equal(r.refusal.unsupportedCorrectRate, 1, 'the unsupported case was correctly refused');
  assert.equal(r.refusal.falseRefusalRate, 0, 'the answerable case was not refused');
});

test('human pass rate excludes UNREVIEWED records', () => {
  const r = evaluate(...Object.values(dataset()));
  assert.equal(r.human.answerCorrect.reviewed, 1);
  assert.equal(r.human.answerCorrect.unreviewed, 1);
  assert.equal(r.human.answerCorrect.passRate, 1);
});

// --- validation -------------------------------------------------------------
test('rejects a non-schema-1 or empty gold document', () => {
  assert.throws(() => evaluate({ schemaVersion: 1, cases: [] }, { schemaVersion: 1, cases: [] }),
    /nonempty schemaVersion 1/);
});

test('rejects gold ground truth missing a human reviewer', () => {
  const { gold, pred } = dataset();
  gold.cases[0].reviewed = false;
  assert.throws(() => evaluate(gold, pred), /missing human ground truth/);
});

test('rejects an answerable case with no expected evidence', () => {
  const { gold, pred } = dataset();
  gold.cases[0].expectedChunkIds = [];
  assert.throws(() => evaluate(gold, pred), /evidence inconsistent with answerability/);
});

test('rejects a prediction whose lecture/version does not match the gold case', () => {
  const { gold, pred } = dataset();
  pred.cases[0].datasetVersionId = 999;
  assert.throws(() => evaluate(gold, pred), /lecture\/version mismatch/);
});

test('rejects duplicate predictions for the same id', () => {
  const { gold, pred } = dataset();
  pred.cases.push(predCase());
  assert.throws(() => evaluate(gold, pred), /Unknown or duplicate prediction/);
});

test('rejects an invalid human verdict value', () => {
  const { gold, pred } = dataset();
  pred.cases[0].human.grounded = 'MAYBE';
  assert.throws(() => evaluate(gold, pred), /invalid human verdict/);
});
