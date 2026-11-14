'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
function loadStream(mocks){
 const filename=path.resolve(__dirname,'../../frontend/src/lib/chat-stream.ts');
 const transpiled=ts.transpileModule(fs.readFileSync(filename,'utf8'),{fileName:filename,compilerOptions:{
  module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020},reportDiagnostics:true});
 assert.equal((transpiled.diagnostics||[]).filter(x=>x.category===ts.DiagnosticCategory.Error).length,0);
 const m=new Module(filename,module);m.filename=filename;
 m.require=name=>{if(!(name in mocks))throw Error('Unmocked client import '+name);return mocks[name];};
 m._compile(transpiled.outputText,filename);return m.exports;
}
const stream=loadStream({'./auth-token':{getAccessToken:()=> 'short-access',refreshAccessToken:async()=> 'renewed-access'}});
function response(chunks,status=200){
 const body=new ReadableStream({start(ctrl){for(const ch of chunks)ctrl.enqueue(new TextEncoder().encode(ch));ctrl.close();}});
 return {ok:status>=200&&status<300,status,body,json:async()=>({message:'Daily limit reached'})};
}
function withFetch(fn){const prior=global.fetch;return async()=>{try{await fn();}finally{global.fetch=prior;}};}
test('SSE body forwards exact English mode and authoritative final sources',withFetch(async()=>{
 const calls=[],parts=[],events=[];
 global.fetch=async(url,options)=>{
  calls.push({url,options});
  return response([
   ': keep-alive\n\n',
   'event: delta\ndata: {"text":"Draft"}\n\n',
   'event: reset\ndata: {}\n\n',
   'event: delta\ndata: {"text":"New draft"}\n\n',
   'event: final\ndata: {"answer":"Verified answer","sources":[{"id":12}]}\n\n']);
 };
 const result=await stream.streamAsk({lectureId:7,sessionId:23,question:'Explain precision',tutoringMode:'EXAM_PREP'},
  {onDelta:x=>parts.push(x),onReset:()=>events.push('reset')},new AbortController().signal);
 assert.deepEqual(parts,['Draft','New draft']);assert.deepEqual(events,['reset']);
 assert.equal(result.answer,'Verified answer');assert.equal(result.sources[0].id,12);
 assert.equal(calls.length,1);assert.equal(JSON.parse(calls[0].options.body).tutoringMode,'EXAM_PREP');
 assert.equal(calls[0].options.headers.Authorization,'Bearer short-access');
}));
test('SSE refresh retry preserves selected mode on 401',withFetch(async()=>{
 const seen=[];
 global.fetch=async(_url,options)=>{
  seen.push({bearer:options.headers.Authorization,body:JSON.parse(options.body)});
  return seen.length===1?response([],401):response(['event: final\ndata: {"answer":"Done","sources":[]}\n\n']);
 };
 const result=await stream.streamAsk({lectureId:2,sessionId:4,question:'Example?',tutoringMode:'REAL_LIFE_EXAMPLE'},
  {onDelta(){},onReset(){}},new AbortController().signal);
 assert.equal(result.answer,'Done');
 assert.deepEqual(seen.map(x=>x.body.tutoringMode),['REAL_LIFE_EXAMPLE','REAL_LIFE_EXAMPLE']);
 assert.equal(seen[1].bearer,'Bearer renewed-access');
}));
test('429 does not silently fall back to GraphQL',withFetch(async()=>{
 global.fetch=async()=>response([],429);
 await assert.rejects(stream.streamAsk({lectureId:2,sessionId:4,question:'Again',tutoringMode:'SIMPLE'},
  {onDelta(){},onReset(){}},new AbortController().signal),e=>e instanceof stream.StreamRateLimitedError);
}));
test('No SSE events signals a safe transport fallback',withFetch(async()=>{
 global.fetch=async()=>response([],503);
 await assert.rejects(stream.streamAsk({lectureId:2,sessionId:4,question:'Again',tutoringMode:'ACADEMIC'},
  {onDelta(){},onReset(){}},new AbortController().signal),e=>e instanceof stream.StreamUnavailableError);
}));
test('Interrupted after draft is not eligible for a duplicate request',withFetch(async()=>{
 global.fetch=async()=>response(['event: delta\ndata: {"text":"Draft"}\n\n'],200);
 await assert.rejects(stream.streamAsk({lectureId:2,sessionId:4,question:'Again',tutoringMode:'ACADEMIC'},
  {onDelta(){},onReset(){}},new AbortController().signal),e=>e instanceof stream.StreamServerError && !(e instanceof stream.StreamUnavailableError));
}));

test('SSE route does not send provisional answer tokens before guardrail final',()=>{
 const route=fs.readFileSync(path.resolve(__dirname,'../src/routes/chat.routes.ts'),'utf8');
 assert.match(route,/send\\('processing', \\{\\}\\)/);
 assert.match(route,/onDelta: \\(\\) => \\{\\}/);
 assert.match(route,/onReset: \\(\\) => \\{\\}/);
 assert.doesNotMatch(route,/send\\('delta',/);
 assert.match(route,/send\\('final', \\{ answer, sources:/);
});
test('SSE processing event keeps final authoritative result',withFetch(async()=>{
 const seen=[];
 global.fetch=async()=>response([
  'event: processing\\ndata: {}\\n\\n',
  'event: final\\ndata: {"answer":"Creative prompts seek imaginative output.","sources":[{"id":18826}]}\\n\\n'
 ]);
 const result=await stream.streamAsk({lectureId:2,sessionId:4,question:'What are Creative Prompts?',tutoringMode:'SIMPLE'},{
  onDelta:x=>seen.push(x),
  onReset:()=>seen.push('reset')
 },new AbortController().signal);
 assert.deepEqual(seen,[]);
 assert.equal(result.answer,'Creative prompts seek imaginative output.');
 assert.equal(result.sources[0].id,18826);
}));
