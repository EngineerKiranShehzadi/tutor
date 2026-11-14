/** Observed progress, NOT a causal estimate of tutoring effectiveness. */
export const MIN_COMPARABLE_QUESTIONS_PER_QUIZ=3;
export type ProgressAssessment={quizId:number;attempted:number;correct:number;submittedAt:string};
export type ObservedChange={first:ProgressAssessment;latest:ProgressAssessment;firstPercent:number;latestPercent:number;changePoints:number};
export function observedChange(rows:ProgressAssessment[]):ObservedChange|null {
 const eligible=rows.filter(r=>Number.isSafeInteger(r.quizId)&&r.quizId>0&&
   Number.isSafeInteger(r.attempted)&&r.attempted>=MIN_COMPARABLE_QUESTIONS_PER_QUIZ&&
   Number.isSafeInteger(r.correct)&&r.correct>=0&&r.correct<=r.attempted&&
   typeof r.submittedAt==='string'&&Number.isFinite(Date.parse(r.submittedAt)));
 // Each submitted quiz is one observation, even if an upstream join repeats it.
 // Prefer the latest timestamp for duplicate IDs, then compare distinct quizzes.
 const unique=new Map<number,ProgressAssessment>();
 for(const row of eligible){
  const previous=unique.get(row.quizId);
  if(!previous||Date.parse(row.submittedAt)>Date.parse(previous.submittedAt))unique.set(row.quizId,row);
 }
 const sorted=[...unique.values()].sort((a,b)=>
  new Date(a.submittedAt).getTime()-new Date(b.submittedAt).getTime()||a.quizId-b.quizId);
 if(sorted.length<2||new Set(sorted.map(r=>r.quizId)).size<2)return null;
 const first=sorted[0],latest=sorted[sorted.length-1];
 const firstPercent=Math.round(first.correct*1000/first.attempted)/10;
 const latestPercent=Math.round(latest.correct*1000/latest.attempted)/10;
 return {first,latest,firstPercent,latestPercent,changePoints:Math.round((latestPercent-firstPercent)*10)/10};
}
