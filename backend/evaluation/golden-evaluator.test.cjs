'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {evaluate}=require('./golden-evaluator.cjs');
const gold={schemaVersion:1,cases:[
 {id:'g1',question:'Explain the first concept',category:'factual',lectureId:1,datasetVersionId:4,answerable:true,expectedChunkIds:[2,3],reviewed:true,reviewedBy:'test'},
 {id:'g2',question:'What is not covered?',category:'unsupported',lectureId:1,datasetVersionId:4,answerable:false,expectedChunkIds:[],reviewed:true,reviewedBy:'test'}]};
const base=id=>({id,lectureId:1,datasetVersionId:4,vectorIds:[],hybridIds:[],rerankedIds:[],finalContextIds:[],citationChunkIds:[],refused:false,latencyMs:100,human:{answerCorrect:'UNREVIEWED',grounded:'UNREVIEWED',citationValid:'UNREVIEWED'}});
const preds={schemaVersion:1,cases:[{...base('g1'),vectorIds:[2,9,3],hybridIds:[3,2],rerankedIds:[2,3],finalContextIds:[2,3],citationChunkIds:[2,3],human:{answerCorrect:'PASS',grounded:'PASS',citationValid:'PASS'}},{...base('g2'),refused:true,latencyMs:200}]};
test('golden metrics and human denominators',()=>{
 const r=evaluate(gold,preds);assert.equal(r.retrieval.vector.recallAt5,1);assert.equal(r.retrieval.vector.ndcgAt5,0.9197);
 assert.equal(r.citations.precision,1);assert.equal(r.refusal.unsupportedCorrectRate,1);
 assert.equal(r.human.answerCorrect.unreviewed,1);assert.equal(r.human.answerCorrect.passRate,1);assert.equal(r.latency.p50Ms,150);
});
test('reject cross-version, duplicate, missing or unlabeled evidence',()=>{
 assert.throws(()=>evaluate(gold,{...preds,cases:[{...preds.cases[0],datasetVersionId:5},preds.cases[1]]}),/version mismatch/);
 assert.throws(()=>evaluate(gold,{...preds,cases:[{...preds.cases[0],vectorIds:[2,2]},preds.cases[1]]}),/duplicates/);
 assert.throws(()=>evaluate(gold,{...preds,cases:[preds.cases[0]]}),/Missing/);
 assert.throws(()=>evaluate({...gold,cases:[{...gold.cases[0],reviewed:false},gold.cases[1]]},preds),/human ground truth/);
});
test('no fabricated metrics without answerable examples',()=>{
 const r=evaluate({schemaVersion:1,cases:[gold.cases[1]]},{schemaVersion:1,cases:[preds.cases[1]]});
 assert.equal(r.retrieval.vector.recallAt5,null);assert.equal(r.citations.precision,null);assert.equal(r.refusal.falseRefusalRate,null);
});
