/**
 * Validate a human-reviewed worksheet and export only independently approved
 * golden cases. Never copy suggestedChunkIds into expectedChunkIds.
 * Offline: no DB, embeddings, model calls, or UI changes.
 *
 * Usage: npm run eval:finalize-golden -- <worksheet.json> [--partial]
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const categories = new Set(['factual','conceptual','comparison','compound','follow_up','unsupported','ambiguous','keyword','paraphrase']);
const uniqueIds=(value:unknown):value is number[] =>
  Array.isArray(value)&&value.every(x=>Number.isSafeInteger(x)&&x>0)&&new Set(value).size===value.length;
type Row={id:string;lectureId:number;datasetVersionId:number;question:string;category:string;
 answerable:boolean|null;expectedChunkIds:number[];reviewed:boolean;reviewedBy:string;
 reviewerNotes?:string; evidencePreview?:Array<{chunkId:number}>;suggestedChunkIds?:number[]};
function main(){
 const input=process.argv[2],partial=process.argv.includes('--partial');
 if(!input||process.argv.slice(3).some(x=>x!=='--partial'))
   throw Error('Usage: npm run eval:finalize-golden -- <worksheet.json> [--partial]');
 const filename=resolve(input),doc=JSON.parse(readFileSync(filename,'utf8'));
 if(doc.status!=='HUMAN_REVIEW_PENDING'||!Array.isArray(doc.cases)||!doc.cases.length)
   throw Error('Expected a nonempty HUMAN_REVIEW_PENDING worksheet');
 const seen=new Set<string>(),accepted:Row[]=[],pending:string[]=[];
 for(const row of doc.cases as Row[]){
  if(!row||typeof row.id!=='string'||!/^[A-Za-z0-9._-]{1,80}$/.test(row.id)||seen.has(row.id))
    throw Error('Invalid or duplicate case ID');
  seen.add(row.id);
  if(row.lectureId!==doc.lectureId||row.datasetVersionId!==doc.datasetVersionId)
    throw Error(row.id+': pinned lecture/version mismatch');
  if(row.reviewed!==true){pending.push(row.id);continue;}
  if(typeof row.reviewedBy!=='string'||!row.reviewedBy.trim())
    throw Error(row.id+': reviewer identity required');
  if(typeof row.question!=='string'||row.question.trim().length<5||!categories.has(row.category))
    throw Error(row.id+': invalid question/category');
  if(typeof row.answerable!=='boolean'||!uniqueIds(row.expectedChunkIds))
    throw Error(row.id+': answerability and unique evidence IDs required');
  if(row.answerable&&row.expectedChunkIds.length===0)
    throw Error(row.id+': answerable case requires verified evidence IDs');
  if(!row.answerable&&row.expectedChunkIds.length!==0)
    throw Error(row.id+': unsupported case must have zero expected IDs');
  // Suggested evidence is NOT independently verified. The reviewer is
  // responsible for checking the original lecture, not just the preview.
  accepted.push(row);
 }
 if(pending.length&&!partial)throw Error(pending.length+' unreviewed cases; use --partial to export reviewed subset');
 if(!accepted.length)throw Error('No human-reviewed cases; cannot create golden benchmark');
 const gold={schemaVersion:1,cases:accepted.map(r=>({
   id:r.id,lectureId:r.lectureId,datasetVersionId:r.datasetVersionId,
   question:r.question,category:r.category,answerable:r.answerable,
   expectedChunkIds:r.expectedChunkIds,reviewed:true,reviewedBy:r.reviewedBy.trim()
 }))};
 const output=filename.replace(/\.json$/i,'')+'-gold.json';
 if(output===filename)throw Error('Input must end in .json');
 writeFileSync(output,JSON.stringify(gold,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log('Exported '+accepted.length+' reviewed cases; '+pending.length+' pending. Output: '+output);
 console.log('No database changes or automatic evidence approval.');
}
try{main()}catch(e){console.error('[GOLDEN FINALIZE] '+(e as Error).message);process.exitCode=1}
