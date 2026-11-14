'use strict';
/* Offline, deterministic RAG evaluation. No external API or database calls. */
const fs = require('node:fs');
const categories = new Set(['factual','conceptual','comparison','compound','follow_up','unsupported','ambiguous','keyword','paraphrase']);
const judgments = new Set(['PASS','FAIL','UNREVIEWED']);
function check(ok,msg){if(!ok)throw Error(msg);}
function ids(a,name){check(Array.isArray(a)&&a.every(x=>Number.isSafeInteger(x)&&x>0),name+': invalid IDs');check(new Set(a).size===a.length,name+': duplicates');return a;}
function mean(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:null;}
function rnd(n){return n===null?null:Number(n.toFixed(4));}
function fraction(a,b){return b?rnd(a/b):null;}
function pct(v,p){if(!v.length)return null;const x=[...v].sort((a,b)=>a-b),at=(x.length-1)*p,i=Math.floor(at),j=Math.ceil(at);return rnd(x[i]+(x[j]-x[i])*(at-i));}
function evaluate(goldDoc,predDoc){
 check(goldDoc?.schemaVersion===1&&Array.isArray(goldDoc.cases)&&goldDoc.cases.length>0,'Golden JSON requires nonempty schemaVersion 1 cases');
 check(predDoc?.schemaVersion===1&&Array.isArray(predDoc.cases),'Predictions JSON requires schemaVersion 1 cases');
 const gold=goldDoc.cases,gmap=new Map(),pmap=new Map();
 for(const c of gold){
  check(typeof c.id==='string'&&/^[A-Za-z0-9._-]{1,80}$/.test(c.id)&&!gmap.has(c.id),'Invalid/duplicate golden ID');
  check(Number.isSafeInteger(c.lectureId)&&c.lectureId>0&&Number.isSafeInteger(c.datasetVersionId)&&c.datasetVersionId>0,c.id+': invalid lecture/version');
  check(typeof c.question==='string'&&c.question.trim().length>=5&&categories.has(c.category),c.id+': invalid question/category');
  check(typeof c.answerable==='boolean'&&c.reviewed===true&&typeof c.reviewedBy==='string'&&!!c.reviewedBy.trim(),c.id+': missing human ground truth');
  const expected=ids(c.expectedChunkIds,c.id+'.expectedChunkIds');
  check(c.answerable?expected.length>0:expected.length===0,c.id+': gold evidence inconsistent with answerability');
  gmap.set(c.id,c);
 }
 for(const p of predDoc.cases){
  check(p&&gmap.has(p.id)&&!pmap.has(p.id),'Unknown or duplicate prediction: '+p?.id);
  const c=gmap.get(p.id);
  check(p.lectureId===c.lectureId&&p.datasetVersionId===c.datasetVersionId,p.id+': lecture/version mismatch');
  for(const key of ['vectorIds','hybridIds','rerankedIds','finalContextIds','citationChunkIds'])ids(p[key],p.id+'.'+key);
  check(typeof p.refused==='boolean'&&Number.isFinite(p.latencyMs)&&p.latencyMs>=0,p.id+': invalid response');
  check(p.human&&['answerCorrect','grounded','citationValid'].every(k=>judgments.has(p.human[k])),p.id+': invalid human verdict');
  pmap.set(p.id,p);
 }
 check(pmap.size===gold.length,'Missing golden-case predictions');
 const eligible=gold.filter(c=>c.answerable),unsupported=gold.filter(c=>!c.answerable);
 const retrieval={};
 for(const [key,name] of [['vectorIds','vector'],['hybridIds','hybrid'],['rerankedIds','reranked'],['finalContextIds','finalContext']]){
  const scores=eligible.map(c=>{
   const ranked=pmap.get(c.id)[key],expect=new Set(c.expectedChunkIds);
   const hits=k=>ranked.slice(0,k).filter(x=>expect.has(x)).length/expect.size;
   const first=ranked.findIndex(x=>expect.has(x));
   const dcg=ranked.slice(0,5).reduce((s,x,i)=>s+(expect.has(x)?1/Math.log2(i+2):0),0);
   const ideal=Array.from({length:Math.min(expect.size,5)},(_,i)=>1/Math.log2(i+2)).reduce((a,b)=>a+b,0);
   return {r5:hits(5),r15:hits(15),mrr:first<0?0:1/(first+1),ndcg:dcg/ideal};
  });
  retrieval[name]={count:scores.length,recallAt5:rnd(mean(scores.map(s=>s.r5))),recallAt15:rnd(mean(scores.map(s=>s.r15))),mrr:rnd(mean(scores.map(s=>s.mrr))),ndcgAt5:rnd(mean(scores.map(s=>s.ndcg)))};
 }
 const citations=eligible.reduce((a,c)=>{
  const p=pmap.get(c.id).citationChunkIds,e=new Set(c.expectedChunkIds);
  a.correct+=p.filter(id=>e.has(id)).length;a.predicted+=p.length;a.expected+=e.size;return a;
 },{correct:0,predicted:0,expected:0});
 const verdict=field=>{const rated=gold.map(c=>pmap.get(c.id).human[field]).filter(v=>v!=='UNREVIEWED');return{reviewed:rated.length,unreviewed:gold.length-rated.length,passRate:fraction(rated.filter(x=>x==='PASS').length,rated.length)};};
 const byCategory=Object.fromEntries([...categories].filter(cat=>gold.some(c=>c.category===cat)).map(cat=>[cat,{cases:gold.filter(c=>c.category===cat).length}]));
 return {schemaVersion:1,caseCount:gold.length,answerable:eligible.length,unsupported:unsupported.length,lectureVersions:[...new Set(gold.map(c=>c.lectureId+':'+c.datasetVersionId))],
 retrieval,citations:{...citations,precision:fraction(citations.correct,citations.predicted),recall:fraction(citations.correct,citations.expected)},
 refusal:{unsupportedCorrectRate:fraction(unsupported.filter(c=>pmap.get(c.id).refused).length,unsupported.length),falseRefusalRate:fraction(eligible.filter(c=>pmap.get(c.id).refused).length,eligible.length)},
 human:{answerCorrect:verdict('answerCorrect'),grounded:verdict('grounded'),citationValid:verdict('citationValid')},
 latency:{p50Ms:pct(gold.map(c=>pmap.get(c.id).latencyMs),.5),p95Ms:pct(gold.map(c=>pmap.get(c.id).latencyMs),.95)},byCategory,
 warnings:['Metrics are conditional on faculty-reviewed expected chunk IDs, not corpus-wide ground truth.','Human verdicts are not automatically scored and UNREVIEWED records are excluded.','Only compare runs for the same golden IDs and pinned lecture-version pairs.']};
}
if(require.main===module){
 try{
  const args=process.argv.slice(2);
  check(args.length===2||args.length===3,'Usage: node evaluation/golden-evaluator.cjs gold.json predictions.json [output.json]');
  const output=JSON.stringify(evaluate(JSON.parse(fs.readFileSync(args[0],'utf8')),JSON.parse(fs.readFileSync(args[1],'utf8'))),null,2)+'\n';
  if(args[2])fs.writeFileSync(args[2],output,{flag:'wx',mode:0o600});process.stdout.write(output);
 }catch(e){console.error('[GOLDEN-RAG] '+e.message);process.exitCode=1;}
}
module.exports={evaluate};
