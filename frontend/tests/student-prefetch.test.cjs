'use strict';
// Offline unit tests for the student read-prefetch gate and the navigation
// allowlist. No server, no network, no Apollo transport — pure logic only.
// The TS source is transpiled in-process; the module has no imports to mock.
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

const { createPrefetchGate, studentDestination } = load('lib/student-prefetch');

// The gate starts work on a microtask (Promise.resolve().then(work)), so tests
// that observe call counts or the started job must let the queue flush first.
const tick = () => new Promise(r => setImmediate(r));

test('gate coalesces concurrent work for the same key', async () => {
  const gate = createPrefetchGate();
  let calls = 0;
  let release;
  const first = gate.run('courses', () => { calls++; return new Promise(r => { release = r; }); });
  const second = gate.run('courses', async () => { calls++; });
  assert.equal(first, second, 'pending promise is shared');
  await tick();
  assert.equal(calls, 1, 'second caller does not start new work while one is pending');
  release();
  await first;
});

test('different keys run independently', async () => {
  const gate = createPrefetchGate();
  let calls = 0;
  await Promise.all([
    gate.run('courses', async () => { calls++; }),
    gate.run('lectures', async () => { calls++; }),
  ]);
  assert.equal(calls, 2);
});

test('a successful read is cached until its TTL expires', async () => {
  let now = 1000;
  const gate = createPrefetchGate(50, 64, () => now);
  let calls = 0;
  await gate.run('courses', async () => { calls++; });
  await gate.run('courses', async () => { calls++; });
  assert.equal(calls, 1, 'second read inside TTL is skipped');
  now = 1051; // TTL elapsed
  await gate.run('courses', async () => { calls++; });
  assert.equal(calls, 2, 'read runs again once the cached entry has expired');
});

test('a failed read is not cached and may be retried immediately', async () => {
  const gate = createPrefetchGate();
  let calls = 0;
  await gate.run('courses', async () => { calls++; throw new Error('network'); });
  await gate.run('courses', async () => { calls++; });
  assert.equal(calls, 2, 'failure leaves nothing cached, so retry proceeds');
});

test('clear() invalidates in-flight generation and cached successes', async () => {
  const gate = createPrefetchGate();
  let calls = 0;
  let release;
  const inflight = gate.run('courses', () => { calls++; return new Promise(r => { release = r; }); });
  await tick();           // let the job start so release is defined
  gate.clear();           // bump generation while work is pending
  release();
  await inflight;         // its success must NOT be recorded (stale generation)
  await gate.run('courses', async () => { calls++; });
  assert.equal(calls, 2, 'post-clear read is not served from a stale cache entry');
});

test('the gate refuses new work once the pending limit is reached', async () => {
  const gate = createPrefetchGate(30_000, 2);
  let started = 0;
  const hold = () => { started++; return new Promise(() => {}); }; // never resolves
  gate.run('a', hold);
  gate.run('b', hold);
  const dropped = gate.run('c', hold); // over the limit of 2
  await tick();
  assert.equal(started, 2, 'third job never starts');
  await assert.doesNotReject(dropped, 'over-limit call resolves quietly instead of throwing');
});

test('studentDestination allows known read-only student paths', () => {
  const origin = 'http://localhost:3000';
  assert.deepEqual(studentDestination('/courses', origin), { path: '/courses' });
  assert.deepEqual(studentDestination('/lectures', origin), { path: '/lectures' });
  assert.deepEqual(studentDestination('/profile/activity', origin), { path: '/profile/activity' });
  assert.deepEqual(studentDestination('/courses/', origin), { path: '/courses' }, 'trailing slash is normalized');
});

test('studentDestination extracts a positive lecture id', () => {
  const origin = 'http://localhost:3000';
  assert.deepEqual(studentDestination('/lecture/42', origin), { path: '/lecture/42', lectureId: '42' });
});

test('studentDestination rejects admin, mutations, foreign origins and bad lecture ids', () => {
  const origin = 'http://localhost:3000';
  for (const href of [
    '/admin/courses',
    '/logout',
    '/graphql',
    '/lecture/0',
    '/lecture/-3',
    '/lecture/01',            // no leading-zero ids
    '/unknown',
    'https://evil.test/courses',
    'javascript:alert(1)',
  ]) {
    assert.equal(studentDestination(href, origin), null, href);
  }
});
