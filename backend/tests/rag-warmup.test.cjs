'use strict';
// Offline, no DB or provider calls. Run from backend with TypeScript installed.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), { test } = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/rag/performance/warmup.ts'), 'utf8');
const moduleUnderTest = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
} }).outputText, { module: moduleUnderTest, exports: moduleUnderTest.exports,
  setTimeout, clearTimeout, Date, Map, Set, Promise, JSON, Number, Error, Math });
const { readWarmupConfig, validLectureId, parseSeed, WarmupCoordinator, borrowWithDeadline,
  warmLecture, WARM_SEARCH_SQL } = moduleUnderTest.exports;
const config = { ...readWarmupConfig({}), enabled: true };
const tick = () => new Promise(r => setImmediate(r));
function fakeClient({ acquired = true, noVersion = false, seeds = ['[0,0]', '[1,0]'], failSearch = false } = {}) {
  const seen = [], releases = [];
  return { seen, releases,
    query: async (sql, values) => {
      seen.push({ sql, values });
      if (sql.includes('pg_try_advisory')) return { rows: [{ acquired }] };
      if (sql.startsWith('SELECT active_version_id')) return { rows: [{ active_version_id: noVersion ? null : 9 }] };
      if (sql.startsWith('WITH numbered')) return { rows: seeds.map(vector_text => ({ vector_text })) };
      if (sql === WARM_SEARCH_SQL) { if (failSearch) throw new Error('db error'); return { rows: [{ id: 19118 }] }; }
      return { rows: [] };
    }, release: destroy => releases.push(destroy === true) };
}
test('disabled by default, bounded settings; malformed configuration is rejected', () => {
  assert.equal(readWarmupConfig({}).enabled, false); assert.equal(config.samples, 2);
  for (const source of [{ RAG_DB_WARMUP_ENABLED: 'yes' }, { RAG_DB_WARMUP_SAMPLES: '0' },
    { RAG_DB_WARMUP_SAMPLES: '99' }, { RAG_DB_WARMUP_TIMEOUT_MS: '-1' }, { RAG_DB_WARMUP_COOLDOWN_MS: 'NaN' }]) {
    assert.throws(() => readWarmupConfig(source));
  }
});
test('lecture IDs and zero/nonfinite/wrong-dimension seeds rejected', () => {
  for (const v of [0,-1,NaN,Infinity,1.5,'4',2147483648]) assert.equal(validLectureId(v), false);
  assert.equal(validLectureId(4), true);
  for (const v of ['[0,0]','[1]','["1",2]','[null,1]','[1e400,1]','bad']) assert.throws(() => parseSeed(v, 2));
  assert.equal(parseSeed('[1,0]',2).length,2);
});
test('disabled coordinator never touches DB', async () => {
  let calls=0; const c=new WarmupCoordinator({...config,enabled:false},async()=>{calls++;});
  assert.equal((await c.run(4)).status,'DISABLED'); assert.equal(calls,0);
});
test('invalid ID rejected before task', async () => {
  const c=new WarmupCoordinator(config,async()=>{throw new Error('should not run');});
  await assert.rejects(c.run(-4),/INVALID_LECTURE_ID/);
});
test('same-lecture callers coalesce; other lectures do not queue work', async () => {
  let finish,calls=0; const c=new WarmupCoordinator(config,async lectureId=>{
    calls++;await new Promise(r=>{finish=r;});return {status:'SAMPLED_WARMUP_COMPLETE',lectureId,versionId:9};
  }); const a=c.run(4),b=c.run(4);assert.equal(a,b);
  assert.equal((await c.run(5)).status,'BUSY');await tick();finish();await a;assert.equal(calls,1);
});
test('cooldown keys include version; failures are not cached as successes', async () => {
  let now=1000000,version=9,fail=false;
  const c=new WarmupCoordinator(config,async (lectureId,recent)=>{
    if(fail)throw new Error('temporary');return {status:recent(version)?'COOLDOWN':'SAMPLED_WARMUP_COMPLETE',lectureId,versionId:version};
  },()=>now);
  assert.equal((await c.run(4)).status,'SAMPLED_WARMUP_COMPLETE');now+=config.globalGapMs;
  assert.equal((await c.run(4)).status,'COOLDOWN');now+=config.globalGapMs;version=10;
  assert.equal((await c.run(4)).status,'SAMPLED_WARMUP_COMPLETE');now+=config.cooldownMs;fail=true;
  await assert.rejects(c.run(4));now+=config.globalGapMs;fail=false;
  assert.equal((await c.run(4)).status,'SAMPLED_WARMUP_COMPLETE');
});
test('late pool checkout is released after timeout', async () => {
  let deliver,released=0;const pool={connect:()=>new Promise(r=>{deliver=r;})};
  await assert.rejects(borrowWithDeadline(pool,5),/CONNECT_TIMEOUT/);
  deliver({release:()=>{released++;}});await tick();assert.equal(released,1);
});
test('pool failure is propagated', async () => {
  await assert.rejects(borrowWithDeadline({connect:async()=>{throw new Error('offline');}},100),/offline/);
});
test('valid seed searches use pinned lecture/version; transaction rolls back', async () => {
  const client=fakeClient();const r=await warmLecture({connect:async()=>client},config,4,2,'test:2',()=>false);
  assert.equal(r.status,'SAMPLED_WARMUP_COMPLETE');assert.equal(r.sampleQueries,1);
  const q=client.seen.find(x=>x.sql===WARM_SEARCH_SQL);
  assert.equal(JSON.stringify(q.values),JSON.stringify(['[1,0]',4,9]));
  assert.equal(client.seen[0].sql,'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(client.seen.at(-1).sql,'ROLLBACK');assert.deepEqual(client.releases,[false]);
});
test('search failure cleans up and cannot fabricate completion', async () => {
  const client=fakeClient({failSearch:true});
  await assert.rejects(warmLecture({connect:async()=>client},config,4,2,'test:2',()=>false));
  assert.equal(client.seen.at(-1).sql,'ROLLBACK');assert.deepEqual(client.releases,[false]);
});
test('replica lock, missing ready version and cooldown skip all sample searches', async () => {
  for(const [options,recent,status] of [[{acquired:false},false,'BUSY'],[{noVersion:true},false,'NOT_READY'],[{},true,'COOLDOWN']]) {
    const client=fakeClient(options);const r=await warmLecture({connect:async()=>client},config,4,2,'test:2',()=>recent);
    assert.equal(r.status,status);assert.equal(client.seen.some(x=>x.sql===WARM_SEARCH_SQL),false);
    assert.deepEqual(client.releases,[false]);
  }
});
test('no valid vectors is a distinct result, not warmed success',async()=>{
  const client=fakeClient({seeds:['[0,0]','bad']});const r=await warmLecture({connect:async()=>client},config,4,2,'test:2',()=>false);
  assert.equal(r.status,'NO_VALID_SEED');assert.equal(r.sampleQueries,0);
});
test('work deadline destroys only its own borrowed connection',async()=>{
  let rejectQuery,releases=0;const client={query:()=>new Promise((_,reject)=>{rejectQuery=reject;}),
    release:destroy=>{assert.equal(destroy,true);releases++;rejectQuery(new Error('cancelled'));}};
  await assert.rejects(warmLecture({connect:async()=>client},{...config,timeoutMs:5},4,2,'test:2',()=>false));
  assert.equal(releases,1);
});
test('rollback failure destroys the checkout rather than returning a bad connection',async()=>{
  const c=fakeClient();const q=c.query;c.query=async(s,v)=>{if(s==='ROLLBACK')throw new Error('lost');return q(s,v);};
  const r=await warmLecture({connect:async()=>c},config,4,2,'test:2',()=>false);
  assert.equal(r.status,'SAMPLED_WARMUP_COMPLETE');assert.deepEqual(c.releases,[true]);
});
test('query and UI wiring preserve scope, auth and no provider calls',()=>{
  assert.match(WARM_SEARCH_SQL,/c\.lecture_id = \$2/);assert.match(WARM_SEARCH_SQL,/version_id = \$3/);
  assert.match(WARM_SEARCH_SQL,/LIMIT 15/);assert.doesNotMatch(source,/halfvec|array_fill|setInterval|generateEmbedding|fetch\(/);
  const route=fs.readFileSync(path.join(root,'src/routes/retrieval-warmup.routes.ts'),'utf8');
  assert.match(route,/protect, limit/);assert.match(route,/validLectureId\(id\)/);
  const ui=fs.readFileSync(path.join(root,'../frontend/src/components/chat/LectureRetrievalWarmup.tsx'),'utf8');
  assert.match(ui,/NEXT_PUBLIC_RAG_DB_WARMUP_ENABLED/);assert.match(ui,/api\.post/);assert.doesNotMatch(ui,/DATABASE_URL|setInterval/);
});
