// Actual helper/Apollo logic and React server render contracts, without a server.
// These are not live browser, provider, or user-network latency measurements.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
const ROOT=path.resolve(__dirname,'../src');
function load(file,mocks={}){
  let full=path.resolve(ROOT,file);if(!/\.tsx?$/.test(full))full+='.ts';
  const input=fs.readFileSync(full,'utf8');const built=ts.transpileModule(input,{fileName:full,reportDiagnostics:true,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}});
  assert.equal((built.diagnostics??[]).filter(d=>d.category===ts.DiagnosticCategory.Error).length,0);
  const mod={exports:{}};
  const localRequire=id=>id in mocks?mocks[id]:id.startsWith('@/')?load(id.slice(2),mocks):id.startsWith('.')?load(path.resolve(path.dirname(full),id),mocks):require(id);
  new Function('require','module','exports',built.outputText)(localRequire,mod,mod.exports);return mod.exports;
}
const {createPrefetchGate,studentDestination}=load('lib/student-prefetch');
test('read prefetch coalesces pending work, expires successes and bounds requests',async()=>{
  let now=1,calls=0,finish;
  const gate=createPrefetchGate(30,1,()=>now);
  const a=gate.run('courses',()=>{calls++;return new Promise(resolve=>{finish=resolve;});});
  const b=gate.run('courses',async()=>{calls++;});assert.equal(a,b);
  await Promise.resolve();await gate.run('other',async()=>{calls++;});assert.equal(calls,1);finish();await a;
  await gate.run('courses',async()=>{calls++;});assert.equal(calls,1);
  now=32;await gate.run('courses',async()=>{calls++;});assert.equal(calls,2);
});
test('failed prefetch can retry and clearing invalidates old success markers',async()=>{
  const gate=createPrefetchGate();let calls=0;
  await gate.run('courses',async()=>{calls++;throw Error('network');});await gate.run('courses',async()=>{calls++;});assert.equal(calls,2);
  gate.clear();await gate.run('courses',async()=>{calls++;});assert.equal(calls,3);
});
test('prefetch allowlist excludes admin, foreign sites, mutations and invalid lectures',()=>{
  const origin='http://localhost:3000';
  assert.deepEqual(studentDestination('/lectures?courseId=4',origin),{path:'/lectures'});
  assert.deepEqual(studentDestination('/lecture/4',origin),{path:'/lecture/4',lectureId:'4'});
  for(const href of ['/admin/courses','/logout','https://elsewhere.test/courses','javascript:alert(1)','/lecture/0','/lecture/-2','/graphql'])assert.equal(studentDestination(href,origin),null,href);
});
test('each student client has its own cache, even with shared transport',()=>{
  const {ApolloLink,gql}=require('@apollo/client');const {createStudentApolloClient}=load('lib/student-apollo');
  const a=createStudentApolloClient(ApolloLink.empty()),b=createStudentApolloClient(ApolloLink.empty());
  const query=gql`query TestAccount { myStats { totalQuestions } }`;
  a.writeQuery({query,data:{myStats:{totalQuestions:7}}});assert.equal(a.readQuery({query}).myStats.totalQuestions,7);assert.equal(b.readQuery({query}),null);a.stop();b.stop();
});
test('late results from an old account stay out of a newly mounted student cache',async()=>{
  const {ApolloLink,Observable,gql}=require('@apollo/client');const {createStudentApolloClient}=load('lib/student-apollo');let deliver;
  const link=new ApolloLink(()=>new Observable(observer=>{deliver=()=>{observer.next({data:{myStats:{totalQuestions:7}}});observer.complete();};}));
  const a=createStudentApolloClient(link),b=createStudentApolloClient(link);const query=gql`query TestLateAccount { myStats { totalQuestions } }`;
  const pending=a.query({query});await Promise.resolve();deliver();await pending;assert.equal(b.readQuery({query}),null);a.stop();b.stop();
});
test('Apollo exposes cached data while a refresh is still in flight',async()=>{
  const {ApolloLink,Observable,gql}=require('@apollo/client');const {createStudentApolloClient}=load('lib/student-apollo');let deliver;
  const link=new ApolloLink(()=>new Observable(observer=>{deliver=()=>{observer.next({data:{courses:[{id:'1',title:'Fresh course'}]}});observer.complete();};}));
  const client=createStudentApolloClient(link);const query=gql`query TestCachedCourses { courses { id title } }`;
  client.writeQuery({query,data:{courses:[{id:'1',title:'Cached course'}]}});
  const watcher=client.watchQuery({query,fetchPolicy:'cache-and-network'});const values=[];let finished;
  const done=new Promise(resolve=>{finished=resolve;});const subscription=watcher.subscribe({next:value=>{values.push(value);if(!value.loading)finished();},error:error=>{throw error;}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(values.some(v=>v.loading&&v.data.courses[0].title==='Cached course'));deliver();await done;
  assert.equal(values.at(-1).data.courses[0].title,'Fresh course');subscription.unsubscribe();client.stop();
});
test('Courses renders cached cards during refresh, with navigable links',()=>{
  const React=require('react');const {renderToStaticMarkup}=require('react-dom/server');
  const {default:Page}=load('app/(dashboard)/courses/page.tsx',{
    '@apollo/client':{useQuery:()=>({loading:true,data:{courses:[{id:'1',title:'Saved course',subtitle:'',description:'',lectureCount:2,readyCount:2}]},refetch:async()=>{}})},
    '@/graphql/course.queries':{GET_COURSES:{}},
    'next/link':{__esModule:true,default:({children,...props})=>React.createElement('a',props,children)},
  });
  const html=renderToStaticMarkup(React.createElement(Page));assert.match(html,/Saved course/);assert.match(html,/href="\/lectures\?courseId=1"/);assert.doesNotMatch(html,/aria-label="Loading courses"/);
});
test('Courses keeps failure separate from genuine empty results',()=>{
  const React=require('react');const {renderToStaticMarkup}=require('react-dom/server');
  function render(result){const {default:Page}=load('app/(dashboard)/courses/page.tsx',{'@apollo/client':{useQuery:()=>({...result,refetch:async()=>{}})},'@/graphql/course.queries':{GET_COURSES:{}},'next/link':{__esModule:true,default:({children,...props})=>React.createElement('a',props,children)}});return renderToStaticMarkup(React.createElement(Page));}
  assert.match(render({loading:false,error:Error('offline')}),/Courses could not be loaded/);
  assert.doesNotMatch(render({loading:false,error:Error('offline')}),/No courses available/);
  assert.match(render({loading:false,data:{courses:[]}}),/No courses available/);
});
test('retake variables contain only the previous owned quiz identifier',()=>{
  const {retakeVariables}=load('lib/practice-retake');assert.deepEqual(retakeVariables(70),{id:70});assert.throws(()=>retakeVariables(0),/Invalid quiz/);
  const {RETAKE_PRACTICE_QUIZ,SUBMIT_PRACTICE_QUIZ}=load('graphql/practice.queries');const {print}=require('graphql');
  const operation=print(RETAKE_PRACTICE_QUIZ);assert.match(operation,/retakePracticeQuiz\(id: \$id\)/);assert.doesNotMatch(operation,/\$lectureIds|\$courseId/);
  assert.match(print(SUBMIT_PRACTICE_QUIZ),/PracticeQuizFields/);
});
test('student-only integration preserves admin configuration and explicit quiz generation',()=>{
  const layout=fs.readFileSync(path.join(ROOT,'app/(dashboard)/layout.tsx'),'utf8');
  const provider=fs.readFileSync(path.join(ROOT,'components/student/StudentNavigationProvider.tsx'),'utf8');
  const admin=fs.readFileSync(path.join(ROOT,'app/(admin)/layout.tsx'),'utf8');
  const practice=fs.readFileSync(path.join(ROOT,'app/(dashboard)/practice/page.tsx'),'utf8');
  assert.match(layout,/StudentNavigationProvider key=\{String\(user.id\)\}/);assert.doesNotMatch(admin,/StudentNavigationProvider/);
  assert.doesNotMatch(provider,/\.mutate\(|CREATE_PRACTICE_QUIZ|RETAKE_PRACTICE_QUIZ|localStorage/);
  assert.match(practice,/await retakeQuiz\(\{variables:retakeVariables\(quiz.id\)\}\)/);
  assert.doesNotMatch(practice,/await Promise.all\(\[quizQuery.refetch/);
  assert.doesNotMatch(practice,/useQuery\(GET_PRACTICE_PROGRESS/);
});
