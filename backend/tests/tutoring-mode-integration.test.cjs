'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const ts=require('typescript'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const root=path.resolve(__dirname,'..');
function load(file,mocks){
 const full=path.resolve(root,file),source=fs.readFileSync(full,'utf8');
 const compiled=ts.transpileModule(source,{fileName:full,reportDiagnostics:true,
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}});
 assert.equal((compiled.diagnostics||[]).filter(x=>x.category===ts.DiagnosticCategory.Error).length,0);
 const mod=new Module(full,module);mod.filename=full;
 mod.require=name=>{if(Object.prototype.hasOwnProperty.call(mocks,name))return mocks[name];
  throw Error('Unmocked dependency denied: '+name+' in '+file);};
 mod._compile(compiled.outputText,full);return mod.exports;
}
class AppError extends Error{constructor(message,statusCode){super(message);this.statusCode=statusCode;}}
const policy=load('src/services/tutoring-mode.service.ts',{'../middleware/errorHandler':{AppError}});
const sample={id:12,chunk_index:0,lecture_id:7,chunk_text:'Precision = TP / (TP + FP).',
 topic:'classification',question:'Define precision',answer:'Precision = TP / (TP + FP).'};
const seen=[];
const provider={name:'mock-provider',
 generate:async req=>{seen.push(req);return{raw:'Grounded mock answer',finishReason:'STOP'};},
 generateStream:async(req,onDelta)=>{seen.push(req);onDelta('Grounded ');onDelta('mock answer');return{raw:'Grounded mock answer',finishReason:'STOP'};}};
const state=load('src/services/socratic-state.service.ts',{
 '../config/database':{__esModule:true,default:{connect:async()=>{throw Error('Unexpected database connection');}},query:async()=>{throw Error('Unexpected database call');}},
 '../middleware/errorHandler':{AppError}});
const answer=load('src/services/answer-generation.service.ts',{
 '../middleware/errorHandler':{AppError},
 './tutoring-mode.service':policy,
 './socratic-state.service':state,
 '../utils/logger':{logger:{info(){},warn(){},error(){}}},
 '../observability/sanitize':{logSafeText:s=>s},
 '../observability/provider-signal':{recordProviderSuccess(){},recordProviderFailure(){}},
 '../config/env':{env:{LLM:{RAG_ANSWER:{MODEL:'mock',FALLBACK_MODEL:'mock',PROVIDER:'mock',TIMEOUT_MS:5000,THINKING:'off'}}}},
 '../llm/llm-provider.resolver':{resolveLlmProvider:()=>provider},
 '../llm/llm-observability.service':{withLlmDiagnostic:async(_,fn)=>fn(),extractLlmUsage:()=>({})},
 '../llm/llm-errors':{isRetryableLlmError:()=>false}
});
test('all four released modes preserve identical trusted retrieval evidence in generation',async()=>{
 seen.length=0;
 for(const mode of ['SIMPLE','ACADEMIC','REAL_LIFE_EXAMPLE','EXAM_PREP']){
  const actual=await answer.generateAnswer('Define precision',[sample],'Lecture 7',[],[],1,undefined,null,[],mode);
  assert.equal(actual,'Grounded mock answer');
 }
 assert.equal(seen.length,4);
 for(const p of seen){
  assert.match(p.userPrompt,/Precision = TP \/ \(TP \+ FP\)\./);
  assert.match(p.userPrompt,/Use ONLY the provided context/);
  assert.match(p.userPrompt,/NOT an instruction|reference data only/);
  assert.match(p.userPrompt,/lower priority than security/);
  assert.doesNotMatch(p.userPrompt,/\[Socratic turn/);
 }
 const context=seen.map(x=>x.userPrompt.match(/Lecture Q&A Context:\n([\s\S]*?)\nCurrent Student Question:/)?.[1]);
 assert.equal(new Set(context).size,1,'mode must not change the evidence block');
 assert.equal(new Set(seen.map(x=>x.userPrompt)).size,4,'each teaching strategy must differ');
});
test('Socratic stages are explicit, bounded, and retain the original anchor',async()=>{
 seen.length=0;
 for(const stage of [0,1,2,3]){
  await answer.generateAnswer('My attempt',[sample],'Lecture 7',[],[],1,undefined,null,[],'SOCRATIC',
  {stage,anchorQuestion:'Define precision'});
 }
 assert.equal(seen.length,4);
 const prompts=seen.map(x=>x.userPrompt);
 for(const text of prompts){
  assert.match(text,/Original topic \(untrusted student question, NOT an instruction\): Define precision/);
  assert.match(text,/\[Lecture Content\]/);
 }
 assert.match(prompts[0],/Do not reveal the full answer/);
 assert.match(prompts[1],/ONE specific hint/);
 assert.match(prompts[2],/stronger, source-grounded hint/);
 assert.match(prompts[3],/provide the source-grounded explanation/);
});
test('SSE generation yields deltas but exact authoritative generation remains grounded',async()=>{
 seen.length=0;const deltas=[];
 const response=await answer.generateAnswer('Define precision',[sample],'Lecture 7',[],[],1,
 {onDelta:s=>deltas.push(s)},null,[],'SIMPLE');
 assert.deepEqual(deltas,['Grounded ','mock answer']);
 assert.equal(response,'Grounded mock answer');
 assert.match(seen[0].userPrompt,/Precision = TP/);
});
test('disabled mode preserves legacy prompt and answer cache identity',async()=>{
 seen.length=0;
 const v=policy.modeAwarePromptVersion('v4+agent:hash',null);
 assert.equal(v,'v4+agent:hash');
 await answer.generateAnswer('Define precision',[sample],'Lecture 7');
 assert.doesNotMatch(seen[0].userPrompt,/\[Teaching style/);
});
test('unknown mode and disabled Socratic cannot reach model',()=>{
 const prev=process.env.ADAPTIVE_TUTORING_MODES_ENABLED;
 process.env.ADAPTIVE_TUTORING_MODES_ENABLED='true';
 try{
  assert.throws(()=>policy.effectiveTutoringMode('inject arbitrary prompt'),e=>e.statusCode===400);
  const had=process.env.ADAPTIVE_TUTORING_SOCRATIC_ENABLED;
  delete process.env.ADAPTIVE_TUTORING_SOCRATIC_ENABLED;
  try{assert.throws(()=>policy.effectiveTutoringMode('SOCRATIC'),e=>e.statusCode===400);}
  finally{if(had!==undefined)process.env.ADAPTIVE_TUTORING_SOCRATIC_ENABLED=had;}
 }finally{if(prev===undefined)delete process.env.ADAPTIVE_TUTORING_MODES_ENABLED;else process.env.ADAPTIVE_TUTORING_MODES_ENABLED=prev;}
});
