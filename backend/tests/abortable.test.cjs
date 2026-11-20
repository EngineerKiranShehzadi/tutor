'use strict';
// Offline unit tests for cancellation-aware waiting helpers. Pure logic, no
// imports to mock. Cancelling a wait rejects promptly but never swallows the
// underlying work's eventual settlement.
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

const { checkAborted, abortableSleep, waitWithSignal } = load('utils/abortable');

test('checkAborted is a no-op without a signal or before abort', () => {
  assert.doesNotThrow(() => checkAborted());
  assert.doesNotThrow(() => checkAborted(new AbortController().signal));
});

test('checkAborted throws the signal reason once aborted', () => {
  const ac = new AbortController();
  const reason = new Error('stop');
  ac.abort(reason);
  assert.throws(() => checkAborted(ac.signal), /stop/);
});

test('abortableSleep resolves after its delay when never cancelled', async () => {
  const start = Date.now();
  await abortableSleep(15);
  assert.ok(Date.now() - start >= 10, 'waited roughly the requested time');
});

test('abortableSleep rejects immediately if the signal is already aborted', async () => {
  const ac = new AbortController();
  ac.abort(new Error('already'));
  // checkAborted runs synchronously, so the call throws before returning a
  // promise — pass a function so assert.rejects captures the sync throw.
  await assert.rejects(async () => abortableSleep(1000, ac.signal), /already/);
});

test('abortableSleep rejects when aborted mid-wait', async () => {
  const ac = new AbortController();
  const p = abortableSleep(1000, ac.signal);
  setTimeout(() => ac.abort(new Error('cancelled mid-wait')), 5);
  await assert.rejects(p, /cancelled mid-wait/);
});

test('waitWithSignal passes a resolved value straight through', async () => {
  assert.equal(await waitWithSignal(Promise.resolve(42)), 42);
  const ac = new AbortController();
  assert.equal(await waitWithSignal(Promise.resolve('ok'), ac.signal), 'ok');
});

test('waitWithSignal rejects with the signal reason when cancelled first', async () => {
  const ac = new AbortController();
  let settle;
  const work = new Promise(r => { settle = r; });
  const wrapped = waitWithSignal(work, ac.signal);
  ac.abort(new Error('caller gave up'));
  await assert.rejects(wrapped, /caller gave up/);
  settle('late'); // underlying work still settles without an unhandled rejection
  await assert.doesNotReject(work);
});

test('waitWithSignal surfaces the work rejection when not cancelled', async () => {
  const ac = new AbortController();
  await assert.rejects(waitWithSignal(Promise.reject(new Error('boom')), ac.signal), /boom/);
});
