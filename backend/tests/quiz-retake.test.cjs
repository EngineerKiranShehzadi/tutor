const test=require('node:test');
const assert=require('node:assert/strict');
const {harness,quizHarness,source,pause}=require('./helpers/quiz-harness.cjs');

test('retake derives its exact course/lecture scope from an owned completed quiz',async()=>{
  const h=quizHarness();const before=JSON.stringify(h.previous);
  const result=await h.svc.retakePracticeQuiz('student',70);
  assert.equal(result.courseId,1);assert.deepEqual(result.lectureIds,[4,6]);assert.equal(result.total,10);assert.notEqual(result.id,70);
  assert.deepEqual(h.queries[0].params,[70,'student']);assert.equal(JSON.stringify(h.previous),before);
  assert.ok(h.writes.every(sql=>!/^UPDATE|^DELETE/.test(sql)));
  assert.ok(result.questions.every(q=>q.correctIndex===null&&q.explanation===null));
  assert.ok(h.calls.filter(c=>c.telemetry.operation==='QUIZ_GENERATE').every(c=>c.userPrompt.includes('PREVIOUS QUESTIONS TO AVOID')));
  assert.equal(h.calls.length,3,'novelty shares the existing verifier call');
});
test('another student cannot retake or read the original questions',async()=>{
  const h=quizHarness();await assert.rejects(h.svc.retakePracticeQuiz('other-student',70),e=>e.statusCode===404);
  assert.equal(h.calls.length,0);assert.equal(h.writes.length,0);
});
test('unfinished quizzes cannot be retaken',async()=>{
  const h=quizHarness({previous:{course_id:1,lecture_ids:[4],status:'IN_PROGRESS',question_count:1,questions:[{lectureId:4,question:'A previous long question?',sourceId:1004}]}});
  await assert.rejects(h.svc.retakePracticeQuiz('student',70),e=>e.statusCode===409);assert.equal(h.calls.length,0);
});
test('incomplete saved lecture coverage fails before model requests',async()=>{
  const h=quizHarness({previous:{course_id:1,lecture_ids:[4,6],status:'COMPLETED',question_count:1,questions:[{lectureId:4,question:'A previous long question?',sourceId:1004}]}});
  await assert.rejects(h.svc.retakePracticeQuiz('student',70),/incomplete lecture/);assert.equal(h.calls.length,0);
});
test('invalid quiz identifiers fail without database or provider work',async()=>{
  for(const id of [0,-1,1.5,NaN]){const h=quizHarness();await assert.rejects(h.svc.retakePracticeQuiz('student',id),/Invalid quiz/);assert.equal(h.calls.length,0);assert.equal(h.queries.length,0);}
});
test('exact normalized old questions are rejected before verification',async()=>{
  const old='Which action improves the accuracy of a learned skill?';
  const h=quizHarness({generation:questions=>({raw:JSON.stringify({questions:questions.map(q=>({...q,question:old.toUpperCase()+'  '}))})})});
  await assert.rejects(h.svc.retakePracticeQuiz('student',70),/enough different, grounded/);
  assert.equal(h.calls.filter(c=>c.telemetry.operation==='QUIZ_VERIFY').length,0);assert.equal(h.writes.length,0);
  assert.ok(h.logs.some(l=>/repeatRejected=[1-9]/.test(l)));
});
test('only one repeated question is replaced; accepted new questions survive',async()=>{
  const h=quizHarness({generation:(questions,id,attempt)=>{
    if(id===4&&attempt===1)questions[0].question='Which action improves the accuracy of a learned skill?';
    return {raw:JSON.stringify({questions}),finishReason:'STOP'};
  }});
  const result=await h.svc.retakePracticeQuiz('student',70);
  assert.equal(result.total,10);assert.ok(result.questions.every(q=>!h.previous.questions.some(p=>p.question===q.question)));
  const gen=h.calls.filter(c=>c.telemetry.operation==='QUIZ_GENERATE');assert.equal(gen.length,3);assert.match(gen[2].userPrompt,/EXACTLY 1 NEW/);
  assert.deepEqual(h.calls.filter(c=>c.telemetry.operation==='QUIZ_VERIFY').map(c=>JSON.parse(c.userPrompt).questions.length),[9,1]);
});
test('semantic repetition verdict rejects reworded questions without a separate model call',async()=>{
  const h=quizHarness({verification:(_body,_count,checks)=>({raw:JSON.stringify({checks:checks.map(c=>({...c,distinctFromPrevious:false}))})})});
  await assert.rejects(h.svc.retakePracticeQuiz('student',70),/enough different, grounded/);assert.equal(h.writes.length,0);assert.equal(h.calls.length,6);
});
test('missing semantic novelty checks fail closed on retake',async()=>{
  const h=quizHarness({verification:(_body,_count,checks)=>({raw:JSON.stringify({checks:checks.map(({distinctFromPrevious,...row})=>row)})})});
  await assert.rejects(h.svc.retakePracticeQuiz('student',70),/enough different, grounded/);assert.equal(h.writes.length,0);
});
test('a valid new fact still requires grounded and unambiguous verification',()=>{
  const {verifiedQuestionIndexes}=quizHarness().svc;
  assert.equal(verifiedQuestionIndexes({checks:[{index:0,grounded:false,unambiguous:true,distinctFromPrevious:true}]},1,true).size,0);
  assert.equal(verifiedQuestionIndexes({checks:[{index:0,grounded:true,unambiguous:false,distinctFromPrevious:true}]},1,true).size,0);
  assert.equal(verifiedQuestionIndexes({checks:[{index:0,grounded:true,unambiguous:true,distinctFromPrevious:'true'}]},1,true).size,0);
});
test('novelty normalizes Unicode and detects obvious rewording, preserving negation/numbers',()=>{
  const {normalizeQuestion,repeatsQuestion}=harness().load('services/quiz-novelty');
  assert.equal(normalizeQuestion('  Ａｃｃｕｒａｃｙ — FIRST!'),'accuracy first');
  assert.equal(repeatsQuestion('How does deliberate practice improve technical skill accuracy?',['Does deliberate practice improve technical skill accuracy?']),true);
  assert.equal(repeatsQuestion('Does practice not improve technical skill accuracy?',['Does practice improve technical skill accuracy?']),false);
  assert.equal(repeatsQuestion('What does layer 2 mean in the student learning sequence?',['What does layer 3 mean in the student learning sequence?']),false);
});
test('evidence selection rotates a larger pool, is bounded, and prefers unused sources',()=>{
  const {selectQuizEvidence}=harness().load('services/quiz-evidence-pool.service');
  const rows=Array.from({length:56},(_,i)=>({...source(4),id:i+1,topic:'Topic '+Math.floor(i/4)}));
  const before=JSON.stringify(rows),a=selectQuizEvidence(rows,'attempt-one'),used=new Set(a.map(s=>s.id));
  const b=selectQuizEvidence(rows,'attempt-two',used);
  assert.equal(a.length,14);assert.equal(b.length,14);assert.equal(new Set(b.map(s=>s.id)).size,14);assert.ok(b.every(s=>!used.has(s.id)));
  assert.notDeepEqual(a.map(s=>s.id),b.map(s=>s.id));assert.equal(JSON.stringify(rows),before);
  assert.deepEqual(selectQuizEvidence([], 'empty'),[]);
  assert.equal(selectQuizEvidence(rows.slice(0,2),'short',new Set([1,2])).length,2);
});
test('batched pool loads reuse versioned cache but not data from another course or version',async()=>{
  const calls=[];const h=harness({database:{query:async(sql,params)=>{calls.push(params);return {rows:params[1].map((id,i)=>({...source(id),version_id:params[2][i]}))};}}});
  const {loadQuizEvidencePools}=h.load('services/quiz-evidence-pool.service');
  const scope=[{lectureId:4,versionId:14},{lectureId:6,versionId:16}];
  await loadQuizEvidencePools(1,scope);const cached=await loadQuizEvidencePools(1,scope);assert.equal(calls.length,1);assert.ok(cached.every(p=>p.cacheHit));
  await loadQuizEvidencePools(1,[{lectureId:4,versionId:15}]);await loadQuizEvidencePools(2,[{lectureId:4,versionId:15}]);assert.equal(calls.length,3);
});
test('batched overlapping requests coalesce and do not expose mutable cache entries',async()=>{
  let calls=0;const h=harness({database:{query:async(_sql,params)=>{calls++;await pause(5);return {rows:params[1].map((id,i)=>({...source(id),version_id:params[2][i]}))};}}});
  const {loadQuizEvidencePools}=h.load('services/quiz-evidence-pool.service');const scopes=[{lectureId:4,versionId:14}];
  const [a,b]=await Promise.all([loadQuizEvidencePools(1,scopes),loadQuizEvidencePools(1,scopes)]);assert.equal(calls,1);assert.equal(b[0].sharedLoad,true);
  a[0].sources[0].answer='mutated';assert.notEqual((await loadQuizEvidencePools(1,scopes))[0].sources[0].answer,'mutated');
});
test('batched pool rejects cross-version database rows and permits retry after failure',async()=>{
  let calls=0;const h=harness({database:{query:async()=>({rows:[{...source(4),version_id:++calls===1?999:14}]})}});
  const {loadQuizEvidencePools}=h.load('services/quiz-evidence-pool.service');const scopes=[{lectureId:4,versionId:14}];
  await assert.rejects(loadQuizEvidencePools(1,scopes),/scope mismatch/);assert.equal((await loadQuizEvidencePools(1,scopes))[0].sources.length,1);
});

test('source and retake SQL run with real ownership/version isolation in disposable PostgreSQL', {skip:!process.env.QUIZ_TEST_DATABASE_URL},async()=>{
  const url=new URL(process.env.QUIZ_TEST_DATABASE_URL);assert.ok(['localhost','127.0.0.1'].includes(url.hostname)&&url.pathname==='/quiz_latency_test','Disposable local DB only');
  const {Client}=require('pg');const client=new Client({connectionString:url.toString()});await client.connect();
  try{
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE lectures(id int PRIMARY KEY, course_id int)');
    await client.query('CREATE TEMP TABLE lecture_qna_chunks(id int PRIMARY KEY,lecture_id int,topic text,chunk_text text,question text,start_time text)');
    await client.query('CREATE TEMP TABLE dataset_version_chunks(version_id int,chunk_id int,qa_id int,chunk_index int)');
    await client.query('INSERT INTO lectures VALUES (4,1),(6,1),(9,2)');
    await client.query(`INSERT INTO lecture_qna_chunks SELECT g,CASE WHEN g<=112 THEN 4 WHEN g<=224 THEN 6 ELSE 9 END,CASE WHEN g%3=0 THEN 'Topic '||g ELSE NULL END,repeat('Literal source evidence. ',100),'Question '||g,NULL FROM generate_series(1,226) g`);
    await client.query(`INSERT INTO dataset_version_chunks SELECT CASE WHEN id<=112 THEN 14 WHEN id<=224 THEN 16 ELSE 19 END,id,id,0 FROM lecture_qna_chunks`);
    const {QUIZ_EVIDENCE_POOL_SQL}=harness().load('services/quiz-evidence-pool.service');
    const result=await client.query(QUIZ_EVIDENCE_POOL_SQL,[1,[4,6],[14,16],56]);assert.equal(result.rows.length,112);
    assert.equal(result.rows.filter(r=>r.lecture_id===4).length,56);assert.ok(result.rows.every(r=>r.answer.length<=1800&&(r.lecture_id===4?r.version_id===14:r.lecture_id===6&&r.version_id===16)));
    assert.equal((await client.query(QUIZ_EVIDENCE_POOL_SQL,[1,[4,6],[16,14],56])).rows.length,0);
    assert.equal((await client.query(QUIZ_EVIDENCE_POOL_SQL,[2,[4,6],[14,16],56])).rows.length,0);
    const {QUIZ_EVIDENCE_SQL}=harness().load('services/quiz-evidence.service');assert.equal((await client.query(QUIZ_EVIDENCE_SQL,[1,4,14,14])).rows.length,14);
    await client.query('CREATE TEMP TABLE practice_quizzes(id bigint PRIMARY KEY,student_id text,course_id int,lecture_ids int[],status text,question_count int)');
    await client.query('CREATE TEMP TABLE practice_questions(id bigint PRIMARY KEY,quiz_id bigint,lecture_id int,position int,question text,source_chunk_id int)');
    await client.query("INSERT INTO practice_quizzes VALUES (70,'student',1,ARRAY[4,6],'COMPLETED',2)");
    await client.query("INSERT INTO practice_questions VALUES(1,70,4,1,'Question four',1),(2,70,6,2,'Question six',113)");
    const {RETAKE_CONTEXT_SQL}=harness().load('services/quiz-retake-context');
    const owned=(await client.query(RETAKE_CONTEXT_SQL,[70,'student'])).rows[0];assert.deepEqual(owned.lecture_ids,[4,6]);assert.equal(owned.questions.length,2);
    assert.equal((await client.query(RETAKE_CONTEXT_SQL,[70,'other-student'])).rows.length,0);
  }finally{await client.query('ROLLBACK');await client.end();}
});
