'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),ts=require('typescript'),fs=require('node:fs'),Module=require('node:module'),path=require('node:path');
const filename=path.resolve(__dirname,'../src/services/rag-benchmark-report.service.ts');
const compiled=ts.transpileModule(fs.readFileSync(filename,'utf8'),{fileName:filename,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}});
class AppError extends Error{constructor(message,statusCode){super(message);this.statusCode=statusCode;}}
let saved=[];
const evalFn=require('../evaluation/golden-evaluator.cjs').evaluate;
const mocks={
 crypto:require('node:crypto'),
 '../config/database':{query:async(sql,values)=>{
   if(sql.includes('INSERT INTO rag_benchmark_runs')){
     const [label,digest,predDigest,cases,answerable,unsupported,versions,metrics,createdBy]=values;
     const record={id:saved.length+1,label,case_count:cases,answerable_count:answerable,unsupported_count:unsupported,
       lecture_versions:JSON.parse(versions),metrics:JSON.parse(metrics),created_at:new Date()};
     saved.push({record,createdBy,digest,predDigest});return{rows:[record]};
   }
   return{rows:saved.map(x=>x.record).reverse()};
 }},
 '../middleware/errorHandler':{AppError},
 '../../evaluation/golden-evaluator.cjs':{evaluate:evalFn}
};
const moduleFile=new Module(filename,module);moduleFile.filename=filename;
moduleFile.require=name=>{if(Object.hasOwn(mocks,name))return mocks[name];throw Error('Unexpected dependency '+name);};
moduleFile._compile(compiled.outputText,filename);
const svc=moduleFile.exports;
const golden={schemaVersion:1,cases:Array.from({length:10},(_,i)=>({
 id:'eval-'+i,question:i===9?'What was never taught in this lecture?':'Define the concept '+i,
 category:i===9?'unsupported':'factual',lectureId:3,datasetVersionId:2,answerable:i!==9,
 expectedChunkIds:i===9?[]:[i+1],reviewed:true,reviewedBy:'fixture-reviewer'
}))};
const predictions={schemaVersion:1,cases:golden.cases.map(c=>({
 id:c.id,lectureId:c.lectureId,datasetVersionId:c.datasetVersionId,
 vectorIds:[...c.expectedChunkIds],hybridIds:[...c.expectedChunkIds],rerankedIds:[...c.expectedChunkIds],
 finalContextIds:[...c.expectedChunkIds],citationChunkIds:[...c.expectedChunkIds],refused:!c.answerable,
 latencyMs:120,human:{answerCorrect:'UNREVIEWED',grounded:'UNREVIEWED',citationValid:'UNREVIEWED'}
}))};
test('server recomputes aggregates and stores no raw questions',async()=>{
 saved=[];const item=await svc.importRagBenchmark('Offline fixture','Example label',JSON.stringify(golden),JSON.stringify(predictions));
 assert.equal(item.caseCount,10);
 assert.equal(saved[0].createdBy,'Offline fixture');
 assert.equal(saved[0].record.metrics.human.answerCorrect.passRate,null);
 const persisted=JSON.stringify(saved);assert.ok(!persisted.includes('Define the concept'));
 assert.ok(!persisted.includes('What was never taught'));
 assert.equal((await svc.listRagBenchmarks())[0].id,1);
});
test('rejects missing gold items, unreviewed gold and tiny benchmark',async()=>{
 await assert.rejects(svc.importRagBenchmark('admin','Valid label','{}',JSON.stringify(predictions)),/Benchmark rejected/);
 const unreviewed=structuredClone(golden);unreviewed.cases[0].reviewed=false;
 await assert.rejects(svc.importRagBenchmark('admin','Valid label',JSON.stringify(unreviewed),JSON.stringify(predictions)),/Benchmark rejected/);
 const tiny={schemaVersion:1,cases:golden.cases.slice(0,9)};
 const tinyPred={schemaVersion:1,cases:predictions.cases.slice(0,9)};
 await assert.rejects(svc.importRagBenchmark('admin','Valid label',JSON.stringify(tiny),JSON.stringify(tinyPred)),/10–2000/);
});
