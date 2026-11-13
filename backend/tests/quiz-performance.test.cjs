// Actual TypeScript modules, deterministic database/model substitutes.
// No .env, real API, embedding quota, or production database is used.
const test=require('node:test');
const assert=require('node:assert/strict');
const {harness,quizHarness,source,pause,response}=require('./helpers/quiz-harness.cjs');

test('queue grants an idle slot immediately',async()=>{
  const {GeminiRequestQueue}=harness().load('llm/providers/gemini-request-queue');
  assert.ok(await new GeminiRequestQueue(()=>1,20).acquire()>=0);
});
test('queue respects the RPM window',async()=>{
  const {GeminiRequestQueue}=harness().load('llm/providers/gemini-request-queue');
  const queue=new GeminiRequestQueue(()=>1,25);await queue.acquire();
  assert.ok(await queue.acquire(undefined,1000)>=20);
});
test('cancelled queue work has no phantom reservation',async()=>{
  const {GeminiRequestQueue}=harness().load('llm/providers/gemini-request-queue');
  let now=0;const queue=new GeminiRequestQueue(()=>1,100,()=>now);await queue.acquire();
  const c=new AbortController();const waiting=queue.acquire(c.signal,1000);c.abort(Error('cancel test'));
  await assert.rejects(waiting,/cancel test/);now=100;
  assert.equal(await queue.acquire(undefined,1000),0);
});
test('queue wait timeout rejects before dispatch',async()=>{
  const {GeminiRequestQueue}=harness().load('llm/providers/gemini-request-queue');
  const queue=new GeminiRequestQueue(()=>1,100);await queue.acquire();
  await assert.rejects(queue.acquire(undefined,5),e=>e.code==='QUEUE_TIMEOUT');
});
test('queue rejects already cancelled work and invalid limits',()=>{
  const {GeminiRequestQueue}=harness().load('llm/providers/gemini-request-queue');
  const c=new AbortController();c.abort(Error('already cancelled'));
  assert.throws(()=>new GeminiRequestQueue(()=>1).acquire(c.signal),/already cancelled/);
  assert.throws(()=>new GeminiRequestQueue(()=>0).acquire(),/Invalid/);
});
test('queue has bounded pending capacity',async()=>{
  const {GeminiRequestQueue}=harness().load('llm/providers/gemini-request-queue');
  const queue=new GeminiRequestQueue(()=>1,1000);await queue.acquire();const c=new AbortController();
  const waiting=Array.from({length:3},()=>queue.acquire(c.signal).catch(e=>e));
  await assert.rejects(queue.acquire(),e=>e.code==='QUEUE_FULL');c.abort(Error('cleanup'));await Promise.all(waiting);
});
test('provider HTTP response timer excludes queue waiting',async()=>{
  const {createGeminiLlmProvider}=harness().load('llm/providers/gemini-llm.provider');
  const provider=createGeminiLlmProvider({queue:{acquire:async()=>{await pause(50);return 50;}},
    fetch:async(_url,init)=>{assert.equal(init.signal.aborted,false);return response();}});
  assert.equal((await provider.generate({model:'test',userPrompt:'not logged',timeoutMs:15})).raw,'{"questions":[]}');
});
test('provider parent cancellation while queued makes no HTTP call',async()=>{
  const h=harness();const {abortableSleep}=h.load('utils/abortable');
  const {createGeminiLlmProvider}=h.load('llm/providers/gemini-llm.provider');let sent=0;
  const provider=createGeminiLlmProvider({queue:{acquire:async signal=>{await abortableSleep(1000,signal);return 1000;}},fetch:async()=>{sent++;return response();}});
  const c=new AbortController();const work=provider.generate({model:'test',userPrompt:'hidden',signal:c.signal});c.abort(Error('parent deadline'));
  await assert.rejects(work,/parent deadline/);assert.equal(sent,0);
});
test('provider network timeout aborts HTTP with distinct code',async()=>{
  const h=harness();const {abortableSleep}=h.load('utils/abortable');
  const {createGeminiLlmProvider}=h.load('llm/providers/gemini-llm.provider');
  const provider=createGeminiLlmProvider({queue:{acquire:async()=>0},fetch:async(_url,init)=>{await abortableSleep(1000,init.signal);return response();}});
  await assert.rejects(provider.generate({model:'test',userPrompt:'hidden',timeoutMs:5}),e=>e.code==='MODEL_TIMEOUT');
});
for(const [status,code] of [[429,'RATE_LIMIT'],[401,'MODEL_ACCESS'],[403,'MODEL_ACCESS'],[404,'MODEL_NOT_FOUND']]){
  test(`provider reports HTTP ${status} without retry`,async()=>{
    const {createGeminiLlmProvider}=harness().load('llm/providers/gemini-llm.provider');let calls=0;
    const provider=createGeminiLlmProvider({queue:{acquire:async()=>0},fetch:async()=>{calls++;return response(status);}});
    await assert.rejects(provider.generate({model:'test',userPrompt:'hidden'}),e=>e.code===code);assert.equal(calls,1);
  });
}
test('provider retries overload once and cancels pending retry on deadline',async()=>{
  const {createGeminiLlmProvider}=harness().load('llm/providers/gemini-llm.provider');let calls=0;
  const provider=createGeminiLlmProvider({queue:{acquire:async()=>0},retryDelayMs:1,fetch:async()=>response(++calls===1?503:200)});
  assert.ok(await provider.generate({model:'test',userPrompt:'hidden'}));assert.equal(calls,2);
  const c=new AbortController();let sent=0;
  const cancelled=createGeminiLlmProvider({queue:{acquire:async()=>0},retryDelayMs:100,fetch:async()=>{sent++;setTimeout(()=>c.abort(Error('deadline')),1);return response(503);}});
  await assert.rejects(cancelled.generate({model:'test',userPrompt:'hidden',signal:c.signal}),/deadline/);assert.equal(sent,1);
});
test('provider permanent overload stops after two calls',async()=>{
  const {createGeminiLlmProvider}=harness().load('llm/providers/gemini-llm.provider');let calls=0;
  const provider=createGeminiLlmProvider({queue:{acquire:async()=>0},retryDelayMs:1,fetch:async()=>{calls++;return response(503);}});
  await assert.rejects(provider.generate({model:'test',userPrompt:'hidden'}),e=>e.code==='MODEL_OVERLOADED');assert.equal(calls,2);
});
test('provider separates malformed response and network failures and redacts logs',async()=>{
  const h=harness();const {createGeminiLlmProvider}=h.load('llm/providers/gemini-llm.provider');const base={queue:{acquire:async()=>0}};
  await assert.rejects(createGeminiLlmProvider({...base,fetch:async()=>{throw Error('NEVER-LOG-THIS-KEY');}}).generate({model:'test',userPrompt:'PRIVATE-LECTURE-TEXT'}),e=>e.code==='NETWORK_FAILURE');
  await assert.rejects(createGeminiLlmProvider({...base,fetch:async()=>({ok:true,json:async()=>{throw SyntaxError('bad JSON');}})}).generate({model:'test',userPrompt:'PRIVATE-LECTURE-TEXT'}),e=>e.code==='INVALID_RESPONSE');
  assert.doesNotMatch(h.logs.join('\n'),/NEVER-LOG-THIS-KEY|PRIVATE-LECTURE-TEXT/);
});
test('provider preserves structured output, thinking off and usage',async()=>{
  const {createGeminiLlmProvider}=harness().load('llm/providers/gemini-llm.provider');let body;
  const provider=createGeminiLlmProvider({queue:{acquire:async()=>0},fetch:async(_url,init)=>{body=JSON.parse(init.body);return response(200,{candidates:[{content:{parts:[{thought:true,text:'private reasoning'},{text:'{"ok":true}'}]},finishReason:'STOP'}],usageMetadata:{totalTokenCount:20}});}});
  const result=await provider.generate({model:'gemini-2.5-flash-lite',userPrompt:'test',thinking:'off',responseSchema:{type:'OBJECT'}});
  assert.equal(body.generationConfig.responseMimeType,'application/json');assert.equal(body.generationConfig.thinkingConfig.thinkingBudget,0);assert.equal(result.raw,'{"ok":true}');assert.equal(result.usage.totalTokens,20);
});
test('two lectures use two generators and one verifier with hidden answers',async()=>{
  const h=quizHarness();const result=await h.svc.createPracticeQuiz('student',1,[4,6]);
  assert.equal(result.total,10);assert.equal(h.calls.length,3);assert.equal(h.committed,true);
  const verify=h.calls.filter(c=>c.telemetry.operation==='QUIZ_VERIFY');
  assert.equal(verify.length,1);assert.equal(JSON.parse(verify[0].userPrompt).questions.length,10);assert.equal(JSON.parse(verify[0].userPrompt).sources.length,2);
  assert.ok(result.questions.every(q=>q.correctIndex===null&&q.explanation===null&&q.selectedIndex===null&&q.source===null));
  assert.ok(h.logs.some(l=>l.startsWith('[QUIZ-TOTAL]')));
});
test('cached source pools are reused but explicit requests generate new quizzes',async()=>{
  const h=quizHarness();const first=await h.svc.createPracticeQuiz('student',1,[4,6]);const second=await h.svc.createPracticeQuiz('student',1,[4,6]);
  assert.notEqual(first.id,second.id);assert.equal(h.calls.length,6);
  assert.equal(h.queries.filter(q=>q.sql.includes('WITH requested')).length,1,'both lecture cache misses are batched');
  assert.equal(h.queries.filter(q=>q.sql.includes('SELECT l.id, l.title')).length,4);assert.ok(h.logs.some(l=>l.includes('cacheHit=true')));
});
test('create uses INSERT RETURNING and no post-save reload queries',async()=>{
  const h=quizHarness();const result=await h.svc.createPracticeQuiz('student',1,[4,6]);
  assert.ok(result.questions.every(q=>q.id>0));assert.equal(h.released,1);
  assert.equal(h.queries.some(q=>q.sql.startsWith('SELECT * FROM practice_quizzes')||q.sql.includes('SELECT q.*, l.title')),false);
  assert.ok(h.writes.filter(q=>q.startsWith('INSERT')).every(q=>q.includes('RETURNING *')));
});
test('one rejected question is repaired without regenerating accepted questions',async()=>{
  const h=quizHarness({verification:(_body,count,checks)=>{if(count===1)checks[0].grounded=false;return {raw:JSON.stringify({checks}),finishReason:'STOP'};}});
  assert.equal((await h.svc.createPracticeQuiz('student',1,[4,6])).total,10);
  const gen=h.calls.filter(c=>c.telemetry.operation==='QUIZ_GENERATE');assert.equal(gen.length,3);assert.match(gen[2].userPrompt,/EXACTLY 1 NEW/);assert.match(gen[2].userPrompt,/Do not repeat these accepted/);
  assert.deepEqual(h.calls.filter(c=>c.telemetry.operation==='QUIZ_VERIFY').map(v=>JSON.parse(v.userPrompt).questions.length),[10,1]);
});
test('malformed verifier fails closed and never saves unverified questions',async()=>{
  const h=quizHarness({verification:()=>({raw:'{"checks":[]}',finishReason:'STOP'})});
  await assert.rejects(h.svc.createPracticeQuiz('student',1,[4,6]),/enough grounded/);assert.equal(h.writes.length,0);assert.equal(h.calls.length,6);
});
test('invented evidence is rejected before verification',async()=>{
  const h=quizHarness({generation:questions=>({raw:JSON.stringify({questions:questions.map(q=>({...q,evidenceQuote:'Invented evidence not present in the lecture.'}))})})});
  await assert.rejects(h.svc.createPracticeQuiz('student',1,[4,6]),/enough grounded/);assert.equal(h.calls.filter(c=>c.telemetry.operation==='QUIZ_VERIFY').length,0);assert.equal(h.writes.length,0);
});
test('changed active versions prevent saving; evidence scopes are paired',async()=>{
  const h=quizHarness({eligibility:(call,lectures)=>call===1?lectures:lectures.map(l=>({...l,active_version_id:l.active_version_id+1}))});
  await assert.rejects(h.svc.createPracticeQuiz('student',1,[4,6]),/material changed/);assert.equal(h.writes.length,0);
  assert.deepEqual(h.queries.find(q=>q.sql.includes('WITH requested')).params,[1,[4,6],[14,16],56]);
});
test('missing or archived lectures stop before model calls',async()=>{
  const h=quizHarness({eligibility:()=>[]});await assert.rejects(h.svc.createPracticeQuiz('student',1,[4,6]),/ready learning material/);assert.equal(h.calls.length,0);assert.match(h.queries[0].sql,/l.archived_at IS NULL AND c.archived_at IS NULL/);
});
test('failed parallel generation cancels its sibling and never saves',async()=>{
  let siblingCancelled=false;
  const h=quizHarness({provider:async req=>{if(req.userPrompt.startsWith('Lecture ID: 4')){await pause(5);throw Error('provider unavailable');}
    await new Promise((_resolve,reject)=>req.signal.addEventListener('abort',()=>{siblingCancelled=true;reject(req.signal.reason);},{once:true}));throw Error('unreachable');}});
  await assert.rejects(h.svc.createPracticeQuiz('student',1,[4,6]),/provider unavailable/);await pause(2);assert.equal(siblingCancelled,true);assert.equal(h.writes.length,0);assert.equal(h.calls.length,2);
});
test('overall deadline clears the duplicate-request guard and prevents writes',async()=>{
  process.env.QUIZ_GENERATION_TIMEOUT_MS='15';try{
    const h=quizHarness({provider:req=>new Promise((_resolve,reject)=>req.signal.addEventListener('abort',()=>reject(req.signal.reason),{once:true}))});
    const first=h.svc.createPracticeQuiz('student',1,[4,6]);await assert.rejects(h.svc.createPracticeQuiz('student',1,[4,6]),/already being generated/);await assert.rejects(first,e=>e.code==='QUIZ_DEADLINE');
    await assert.rejects(h.svc.createPracticeQuiz('student',1,[4,6]),e=>e.code==='QUIZ_DEADLINE');assert.equal(h.writes.length,0);
  }finally{delete process.env.QUIZ_GENERATION_TIMEOUT_MS;}
});
test('late save-connection acquisition releases without inserting',async()=>{
  process.env.QUIZ_GENERATION_TIMEOUT_MS='20';try{const h=quizHarness({connectDelay:60});await assert.rejects(h.svc.createPracticeQuiz('student',1,[4,6]),e=>e.code==='QUIZ_DEADLINE');await pause(80);assert.equal(h.released,1);assert.equal(h.writes.length,0);}finally{delete process.env.QUIZ_GENERATION_TIMEOUT_MS;}
});
test('atomic save rolls back on question insertion failure',async()=>{
  const h=quizHarness({writeFailure:true});await assert.rejects(h.svc.createPracticeQuiz('student',1,[4,6]),/write failed/);assert.equal(h.committed,false);assert.ok(h.writes.includes('ROLLBACK'));assert.equal(h.released,1);
});
test('an incomplete INSERT RETURNING result rolls back',async()=>{
  const h=quizHarness({shortSave:true});await assert.rejects(h.svc.createPracticeQuiz('student',1,[4,6]),/incomplete question set/);assert.equal(h.committed,false);assert.ok(h.writes.includes('ROLLBACK'));
});
test('larger quizzes preserve all lectures and bounded verification batches',async()=>{
  const ids=Array.from({length:12},(_,i)=>i+1),h=quizHarness({lectures:ids});const quiz=await h.svc.createPracticeQuiz('student',1,ids);
  assert.equal(quiz.total,12);assert.deepEqual(quiz.lectureIds,ids);assert.deepEqual(h.calls.filter(c=>c.telemetry.operation==='QUIZ_VERIFY').map(c=>JSON.parse(c.userPrompt).questions.length),[10,2]);
});
test('module import starts no automatic quiz generation',()=>{
  const h=quizHarness();assert.equal(h.calls.length,0);assert.equal(h.queries.length,0);assert.equal(h.writes.length,0);
});
test('compact evidence is bounded and literal',()=>{
  const {compactSources}=harness().load('services/quiz-evidence.service');const rows=Array.from({length:20},(_,i)=>({...source(i),answer:'A complete factual statement about this course. '.repeat(200)}));
  const pack=compactSources(rows);assert.equal(pack.length,14);assert.ok(pack.reduce((sum,s)=>sum+s.answer.length,0)<=6000);assert.ok(pack.every((s,i)=>rows[i].answer.includes(s.answer)));
});
test('legacy source cache keys separate course, lecture and version',async()=>{
  const calls=[];const h=harness({database:{query:async(_sql,params)=>{calls.push(params);return {rows:[source(params[1])]};}}});const {loadQuizEvidence}=h.load('services/quiz-evidence.service');
  await loadQuizEvidence(1,4,9);await loadQuizEvidence(1,4,9);await loadQuizEvidence(1,4,10);await loadQuizEvidence(2,4,10);assert.equal(calls.length,3);
});
test('concurrent source reads share one load, with copies for callers',async()=>{
  let calls=0;const h=harness({database:{query:async()=>{calls++;await pause(5);return {rows:[source()]};}}});const {loadQuizEvidence}=h.load('services/quiz-evidence.service');
  const [a,b]=await Promise.all([loadQuizEvidence(1,4,9),loadQuizEvidence(1,4,9)]);assert.equal(calls,1);assert.equal(b.sharedLoad,true);a.sources[0].answer='changed';assert.notEqual((await loadQuizEvidence(1,4,9)).sources[0].answer,'changed');
});
test('source TTL and LRU eviction work',async()=>{
  process.env.QUIZ_EVIDENCE_CACHE_TTL_MS='15';process.env.QUIZ_EVIDENCE_CACHE_MAX_ENTRIES='1';try{
    let calls=0;const h=harness({database:{query:async(_sql,params)=>{calls++;return {rows:[source(params[1])]};}}});const {loadQuizEvidence}=h.load('services/quiz-evidence.service');
    await loadQuizEvidence(1,4,9);await loadQuizEvidence(1,5,9);await loadQuizEvidence(1,4,9);assert.equal(calls,3);await pause(20);await loadQuizEvidence(1,4,9);assert.equal(calls,4);
  }finally{delete process.env.QUIZ_EVIDENCE_CACHE_TTL_MS;delete process.env.QUIZ_EVIDENCE_CACHE_MAX_ENTRIES;}
});
test('failed source loads are not cached',async()=>{
  let calls=0;const h=harness({database:{query:async()=>{if(++calls===1)throw Error('DB offline');return {rows:[source()]};}}});const {loadQuizEvidence}=h.load('services/quiz-evidence.service');
  await assert.rejects(loadQuizEvidence(1,4,9),/DB offline/);assert.equal((await loadQuizEvidence(1,4,9)).sources.length,1);assert.equal(calls,2);
});
