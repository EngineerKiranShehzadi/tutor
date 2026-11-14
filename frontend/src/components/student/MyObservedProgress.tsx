'use client';
import {useQuery} from '@apollo/client';
import {GET_MY_OBSERVED_PROGRESS} from '@/graphql/learning-effectiveness.queries';
type Result={
 outcomeId:number;code:string;description:string;eligibleQuizCount:number;
 firstPercent:number|null;latestPercent:number|null;changePoints:number|null;
 firstSubmittedAt:string|null;latestSubmittedAt:string|null;interpretation:string;
};
export function MyObservedProgress({courseId}:{courseId:number}){
 const result=useQuery(GET_MY_OBSERVED_PROGRESS,{variables:{courseId},fetchPolicy:'cache-and-network'});
 const rows:Result[]=result.data?.myObservedLearningProgress??[];
 const format=(v:number|null)=>v===null?'Not measured':v.toFixed(1)+'%';
 return <section className="mt-5 rounded-card border border-[var(--border)] bg-[var(--card)] p-5" aria-label="Observed learning progress">
  <h2 className="text-h3 font-semibold text-[var(--text)]">Your Learning Progress Over Time</h2>
  <p className="text-caption text-[var(--muted)] mt-1 mb-4">Compare your first and latest completed quizzes with at least three faculty-mapped answers for the same learning outcome. These are observed quiz results, not official grades or proof of AI tutoring impact.</p>
  {result.loading&&!result.data&&<p role="status" className="text-label text-[var(--muted)]">Loading your quiz comparisons…</p>}
  {result.error&&<p role="alert" className="text-label text-[var(--text)]">Could not load learning progress. <button type="button" onClick={()=>void result.refetch()} className="font-semibold underline">Retry</button></p>}
  {!result.loading&&!result.error&&!rows.length&&<p className="text-label text-[var(--muted)]">There is no faculty-mapped completed quiz evidence available for this course.</p>}
  <div className="space-y-3">
   {rows.map(row=><article key={row.outcomeId} className="rounded-control border border-[var(--border)] bg-[var(--surface)] p-4">
    <h3 className="text-label font-semibold text-[var(--text)]">{row.code} · {row.description}</h3>
    {row.changePoints===null?
     <p className="mt-2 text-caption text-[var(--muted)]">More comparable quiz evidence needed. At least two completed quizzes, each with three or more mapped answers, are required. Current qualifying quizzes: {row.eligibleQuizCount}.</p>
     : <>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
       <div><p className="text-caption text-[var(--muted)]">First qualifying quiz</p><p className="text-h3 font-semibold text-[var(--text)]">{format(row.firstPercent)}</p></div>
       <div><p className="text-caption text-[var(--muted)]">Latest qualifying quiz</p><p className="text-h3 font-semibold text-[var(--text)]">{format(row.latestPercent)}</p></div>
       <div><p className="text-caption text-[var(--muted)]">Observed change</p><p className="text-h3 font-semibold text-[var(--text)]">{row.changePoints>0?'+':''}{row.changePoints.toFixed(1)} percentage points</p></div>
      </div>
      <p className="mt-3 text-caption text-[var(--muted)]">Quiz forms and difficulty may differ. This descriptive comparison cannot establish that AI tutoring caused the change.</p>
     </>}
   </article>)}
  </div>
 </section>;
}
