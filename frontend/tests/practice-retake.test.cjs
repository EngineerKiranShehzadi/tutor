'use strict';
// Offline unit tests for retake variable hardening. A retake must only ever
// forward a validated quiz id and never trust client-supplied course/lecture
// data. Pure logic, no imports to mock.
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

const { retakeVariables } = load('lib/practice-retake');

test('a valid positive quiz id passes through unchanged and alone', () => {
  assert.deepEqual(retakeVariables(7), { id: 7 });
  assert.deepEqual(Object.keys(retakeVariables(7)), ['id'], 'no extra client-supplied fields leak through');
});

test('non-positive ids are rejected', () => {
  for (const bad of [0, -1, -9999]) {
    assert.throws(() => retakeVariables(bad), /Invalid quiz\./, String(bad));
  }
});

test('non-integer and unsafe values are rejected', () => {
  for (const bad of [1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => retakeVariables(bad), /Invalid quiz\./, String(bad));
  }
});
