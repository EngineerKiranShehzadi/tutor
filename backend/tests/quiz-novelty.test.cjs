'use strict';
// Offline unit tests for the lexical novelty gate that stops practice quizzes
// from repeating a previous question. Pure logic, no imports to mock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load(relFromSrc) {
  const file = path.resolve(__dirname, '../src', relFromSrc) + '.ts';
  const built = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  const errors = (built.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, JSON.stringify(errors.map(e => ts.flattenDiagnosticMessageText(e.messageText, '\n'))));
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', built.outputText)(require, mod, mod.exports);
  return mod.exports;
}

const { normalizeQuestion, repeatsQuestion } = load('services/quiz-novelty');

test('normalizeQuestion lowercases, strips punctuation and collapses whitespace', () => {
  assert.equal(normalizeQuestion('  What   does Integrity, MEAN?? '), 'what does integrity mean');
});

test('normalizeQuestion folds compatibility characters (NFKC)', () => {
  // Fullwidth "ABC" normalizes to ascii "abc".
  assert.equal(normalizeQuestion('ＡＢＣ'), 'abc');
});

test('an exact restatement is flagged as a repeat', () => {
  const previous = ['What does integrity mean?'];
  assert.equal(repeatsQuestion('what does integrity, mean?', previous), true);
});

test('near-identical phrasing above the similarity threshold is a repeat', () => {
  const previous = ['Which action improves the accuracy of a learned skill?'];
  assert.equal(
    repeatsQuestion('Which action improves accuracy of the learned skill?', previous),
    true,
  );
});

test('a genuinely different question is not a repeat', () => {
  const previous = ['What does integrity mean in professional ethics?'];
  assert.equal(repeatsQuestion('How is reinforcement learning different from supervised learning?', previous), false);
});

test('differing numbers keep otherwise-similar questions distinct', () => {
  const previous = ['Which layer sits at position 3 in the reference model stack?'];
  assert.equal(
    repeatsQuestion('Which layer sits at position 5 in the reference model stack?', previous),
    false,
    'a changed quantity must not be treated as a paraphrase',
  );
});

test('negation is preserved — adding "not" makes a question novel', () => {
  const previous = ['Which of these principles describes ethical integrity clearly?'];
  assert.equal(
    repeatsQuestion('Which of these principles does not describe ethical integrity clearly?', previous),
    false,
  );
});

test('short questions below the token floor are never fuzzy-matched', () => {
  // Fewer than 4 content tokens: only an exact normalized match counts.
  assert.equal(repeatsQuestion('Define integrity', ['Define honesty']), false);
});

test('an empty previous list is always novel', () => {
  assert.equal(repeatsQuestion('Any question at all here?', []), false);
});
