'use client';
import Link from 'next/link';
import { useQuery } from '@apollo/client';
import { GET_MY_MISCONCEPTION_EVIDENCE, GET_MY_OUTCOME_TIMELINE } from '@/graphql/misconception.queries';

type Misconception={id:number;outcomeId:number;outcomeCode:string;code:string;description:string;occurrences:number;attempts:number;repeated:boolean;lastSeen:string|null};
type Timeline={outcomeId:number;code:string;quizId:number;submittedAt:string;attempted:number;correct:number};
export function PersonalLearningSignals({courseId,lectureLinks}:{courseId:number;lectureLinks:Record<number,number[]>}){
 const signals=useQuery(GET_MY_MISCONCEPTION_EVIDENCE,{variables:{courseId},fetchPolicy:'cache-and-network'});
 const timeline=useQuery(GET_MY_OUTCOME_TIMELINE,{variables:{courseId},fetchPolicy:'cache-and-network'});
 const items:Misconception[]=signals.data?.myMisconceptionEvidence??[];
 const dates:Timeline[]=timeline.data?.myOutcomeTimeline??[];
 return <>
  <section className="mt-5 rounded-card border border-[var(--border)] bg-[var(--card)] p-5">
   <h2 className="text-h3 font-semibold text-[var(--text)]">Concepts to review</h2>
   <p className="text-caption text-[var(--muted)] mt-1 mb-4">Signals come only from completed quiz choices linked to admin-approved misconceptions. One occurrence is not a confirmed learning difficulty.</p>
   {signals.loading&&!items.length&&<p role="status" className="text-label text-[var(--muted)]">Loading review signals…</p>}
   {signals.error&&<p role="alert" className="text-label text-red-700">Could not load review signals.</p>}
   {!signals.loading&&!signals.error&&!items.length&&<p className="text-label text-[var(--muted)]">No admin-reviewed misconception signals for this course yet.</p>}
   {items.map(m=><article key={m.id} className="border-t border-[var(--border)] py-3 first:border-0">
    <div className="flex justify-between gap-3"><p className="text-label font-semibold text-[var(--text)]">{m.outcomeCode}: {m.description}</p>
      <span className="text-caption text-[var(--muted)] shrink-0">{m.occurrences} {m.occurrences===1?'occurrence':'occurrences'}</span></div>
    <p className="text-caption text-[var(--muted)] mt-1">{m.repeated?'Repeated approved signal':'Single approved signal — not enough to infer a recurring misconception'}</p>
    {(lectureLinks[m.outcomeId]||[]).map(id=><Link key={id} href={'/lecture/'+id} className="inline-block mr-3 mt-2 font-semibold text-caption text-[var(--accent)] hover:underline">Review lecture {id} →</Link>)}
   </article>)}
  </section>
  <section className="mt-5 rounded-card border border-[var(--border)] bg-[var(--card)] p-5">
   <h2 className="text-h3 font-semibold text-[var(--text)]">Learning evidence history</h2>
   <p className="text-caption text-[var(--muted)] mt-1 mb-4">Your submitted quiz results, grouped by admin-mapped outcome. No official grades or inferred mastery scores.</p>
   {timeline.loading&&!dates.length&&<p role="status" className="text-label text-[var(--muted)]">Loading history…</p>}
   {timeline.error&&<p role="alert" className="text-label text-red-700">Could not load learning history.</p>}
   {!timeline.loading&&!timeline.error&&!dates.length&&<p className="text-label text-[var(--muted)]">No mapped quiz history available yet.</p>}
   <ol className="space-y-2">{dates.map(x=><li key={x.outcomeId+'-'+x.quizId} className="flex flex-wrap justify-between gap-2 text-label border-t border-[var(--border)] pt-3 text-[var(--text)]">
    <span>{x.code} · {new Date(x.submittedAt).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}</span>
    <span>{x.correct} / {x.attempted} correct</span>
   </li>)}</ol>
  </section>
 </>;
}
