import {createHash} from 'crypto';
import {query} from '../config/database';
import {AppError} from '../middleware/errorHandler';
// Pure offline evaluator is the single scoring source of truth; never accept
// user-entered accuracy percentages or unverified frontend-calculated totals.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const evaluate: (gold:unknown,predictions:unknown)=>Record<string,any> =
 require('../../evaluation/golden-evaluator.cjs').evaluate;
function parse(raw:string,name:string):any {
 if(typeof raw!=='string'||raw.length===0||raw.length>400000)
  throw new AppError(name+' must contain 1–400000 characters of JSON',400);
 try{return JSON.parse(raw);}catch{throw new AppError(name+' is not valid JSON',400);}
}
function digest(value:unknown):string {
 return createHash('sha256').update(JSON.stringify(value),'utf8').digest('hex');
}
function labelValue(s:string):string {
 if(typeof s!=='string'||s.trim().length<3||s.trim().length>100)
  throw new AppError('Label must be 3–100 characters',400);
 return s.trim();
}
const summary=(r:any)=>({
 id:Number(r.id),label:r.label,caseCount:Number(r.case_count),
 answerable:Number(r.answerable_count),unsupported:Number(r.unsupported_count),
 lectureVersions:r.lecture_versions as string[],
 metrics:JSON.stringify(r.metrics),createdAt:r.created_at.toISOString(),
});
export async function listRagBenchmarks(limit=20){
 if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new AppError('Limit must be 1–50',400);
 const {rows}=await query<any>(
  `SELECT id,label,case_count,answerable_count,unsupported_count,lecture_versions,
   metrics,created_at FROM rag_benchmark_runs ORDER BY created_at DESC,id DESC LIMIT $1`,[limit]);
 return rows.map(summary);
}
export async function importRagBenchmark(adminId:string,label:string,goldJson:string,predictionsJson:string){
 const gold=parse(goldJson,'Golden labels'),predictions=parse(predictionsJson,'Predictions');
 const name=labelValue(label);
 let result:Record<string,any>;
 try{result=evaluate(gold,predictions);}
 catch(e){throw new AppError('Benchmark rejected: '+(e as Error).message,400);}
 // A benchmark needs enough coverage to be educationally interpretable.
 // Smaller experiments remain possible offline but never appear as an official dashboard run.
 if(result.caseCount<10||result.caseCount>2000)throw new AppError('Dashboard requires 10–2000 faculty-reviewed cases',400);
 if(result.answerable===0||result.unsupported===0)
  throw new AppError('Benchmark must include answerable and unsupported examples',400);
 if(result.lectureVersions.some((v:unknown)=>typeof v!=='string'))
  throw new AppError('Invalid dataset scope',400);
 try{
  const {rows}=await query<any>(
   `INSERT INTO rag_benchmark_runs(label,dataset_fingerprint,prediction_fingerprint,
      case_count,answerable_count,unsupported_count,lecture_versions,metrics,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)
     RETURNING id,label,case_count,answerable_count,unsupported_count,lecture_versions,metrics,created_at`,
   [name,digest(gold),digest(predictions),result.caseCount,result.answerable,result.unsupported,
    JSON.stringify(result.lectureVersions),JSON.stringify(result),adminId]);
  return summary(rows[0]);
 }catch(e:any){
  if(e?.code==='23505')throw new AppError('The same benchmark pair has already been imported',409);
  throw e;
 }
}
