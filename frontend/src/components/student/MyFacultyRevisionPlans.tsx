'use client';
import Link from 'next/link';
import {useEffect} from 'react';
import {useQuery} from '@apollo/client';
import {GET_MY_REVISION_RECOMMENDATIONS} from '@/graphql/revision-plan.queries';
type Plan={outcomeId:number;code:string;description:string;lectureId:number;lectureTitle:string;guidance:string;attempted:number;correct:number};
export function MyFacultyRevisionPlans({courseId}:{courseId:number}){
 const result=useQuery(GET_MY_REVISION_RECOMMENDATIONS,{variables:{courseId},fetchPolicy:'cache-and-network'});
 // Admin may approve or withdraw a plan while this student page stays open.
 // Revalidate when the student returns to the tab rather than trusting stale cache.
 useEffect(()=>{
  const refresh=()=>{if(document.visibilityState==='visible')void result.refetch();};
  document.addEventListener('visibilitychange',refresh);
  return ()=>document.removeEventListener('visibilitychange',refresh);
 },[courseId,result.refetch]);
 const plans:Plan[]=result.error?[]:(result.data?.myRevisionRecommendations??[]);
 return <section className="mt-5 rounded-card border border-[var(--border)] bg-[var(--card)] p-5">
  <div className="flex flex-wrap items-center justify-between gap-3">
   <h2 className="text-h3 font-semibold text-[var(--text)]">Your admin-approved revision</h2>
   <button type="button" onClick={()=>void result.refetch()} disabled={result.loading} aria-label="Refresh admin revision guidance" className="text-caption font-semibold text-[var(--accent)] underline disabled:opacity-50">Refresh guidance</button>
  </div>
  <p className="text-caption text-[var(--muted)] mt-1 mb-3">Suggestions based only on your completed mapped quizzes. You decide when to study or request a new quiz.</p>
  {result.loading&&!result.data&&<p role="status" className="text-label text-[var(--muted)]">Loading guidance…</p>}
  {result.error&&<p role="alert" className="text-label text-[var(--text)]">Could not load guidance. <button onClick={()=>void result.refetch()} className="underline">Retry</button></p>}
  {!result.loading&&!result.error&&plans.length===0&&<p className="text-label text-[var(--muted)]">No admin-approved revision action is recommended right now.</p>}
  {plans.map(plan=><article key={plan.outcomeId} className="border-t border-[var(--border)] py-3 first:border-t-0">
   <h3 className="text-label font-semibold text-[var(--text)]">{plan.code}: {plan.description}</h3>
   <p className="text-caption text-[var(--muted)] mt-1">{plan.correct} of {plan.attempted} mapped quiz answers correct</p>
   <p className="text-label text-[var(--text)] mt-2">{plan.guidance}</p>
   <div className="mt-3 flex gap-3 flex-wrap">
    <Link href={'/lecture/'+plan.lectureId} className="text-caption font-semibold text-[var(--accent)] hover:underline">Review {plan.lectureTitle} →</Link>
    <Link href={'/practice?courseId='+courseId} className="text-caption font-semibold text-[var(--accent)] hover:underline">Choose a practice quiz →</Link>
   </div>
  </article>)}
 </section>;
}
