'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@apollo/client';
import { GET_COURSES } from '@/graphql/course.queries';
import { GET_MY_OUTCOME_PROGRESS } from '@/graphql/learning-outcome.queries';

type Course={id:string;title:string};
type Progress={outcomeId:number;code:string;description:string;attempted:number;correct:number;percent:number|null;status:string;lectureIds:number[]};
const labels:Record<string,string>={NOT_ASSESSED:'Not assessed',INSUFFICIENT_EVIDENCE:'More evidence needed',STRONG:'Strong performance',DEVELOPING:'Developing',NEEDS_REVISION:'Needs revision'};
export default function StudentLearningOutcomes(){
  const courses=useQuery(GET_COURSES,{fetchPolicy:'cache-and-network'});
  const all:Course[]=courses.data?.courses??[];
  const [courseId,setCourseId]=useState<number|null>(null);
  useEffect(()=>{
    if(!all.length)return;
    if(courseId!==null&&all.some(c=>Number(c.id)===courseId))return;
    setCourseId(Number(all[0].id));
  },[all,courseId]);
  const progress=useQuery(GET_MY_OUTCOME_PROGRESS,{variables:{courseId:courseId??0},skip:courseId===null,fetchPolicy:'cache-and-network'});
  const rows:Progress[]=progress.data?.myOutcomeProgress??[];
  return <main className="mx-auto max-w-[1000px] px-6 py-10">
    <nav className="text-caption text-[var(--muted)] mb-4"><Link href="/profile/activity" className="hover:text-[var(--accent)]">My Activity</Link> / Learning Outcomes</nav>
    <h1 className="text-h1 font-semibold text-[var(--text)]">Learning Outcomes</h1>
    <p className="text-body text-[var(--muted)] mt-2 mb-6">See what your completed quizzes show about each course goal. This uses faculty-approved question mappings, not chat activity.</p>
    <label htmlFor="student-outcome-course" className="text-label font-semibold text-[var(--text)]">Select course</label>
    <select id="student-outcome-course" value={courseId??''} onChange={e=>setCourseId(Number(e.target.value))} className="mt-2 mb-6 w-full rounded-control border border-[var(--border)] bg-[var(--card)] px-4 py-3 text-label text-[var(--text)]">
      {all.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}
    </select>
    {progress.loading&&!rows.length&&<p role="status" className="text-label text-[var(--muted)]">Loading course outcomes…</p>}
    {progress.error&&<div role="alert" className="rounded-card border border-[var(--border)] bg-[var(--card)] p-5 text-label text-[var(--text)]">Could not load learning outcomes. Please try again. <button onClick={()=>void progress.refetch()} className="underline">Retry</button></div>}
    {!progress.loading&&!progress.error&&!rows.length&&<section className="rounded-card border border-[var(--border)] bg-[var(--card)] p-6"><h2 className="text-h3 font-semibold text-[var(--text)]">No learning outcomes yet</h2><p className="mt-2 text-label text-[var(--muted)]">Your teacher can add course learning outcomes. Meanwhile, you can continue practicing.</p><Link href="/practice" className="inline-block mt-4 font-semibold text-[var(--accent)] hover:underline">Open Practice Quizzes</Link></section>}
    <section className="space-y-4" aria-label="Course learning outcomes">
      {rows.map(r=><article key={r.outcomeId} className="rounded-card border border-[var(--border)] bg-[var(--card)] p-5">
        <div className="flex flex-wrap justify-between gap-3">
          <div><h2 className="text-h3 font-semibold text-[var(--text)]">{r.code}</h2><p className="text-label text-[var(--text)] mt-1">{r.description}</p></div>
          <span className="text-caption rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 h-fit text-[var(--text)]">{labels[r.status]??r.status}</span>
        </div>
        <p className="mt-4 text-caption text-[var(--muted)]">{r.attempted} mapped quiz answers · {r.correct} correct · {r.percent===null?'No score yet':r.percent+'% correct'}</p>
        {r.percent!==null&&<div className="mt-2 h-2 rounded-full bg-[var(--surface)] border border-[var(--border)] overflow-hidden" role="progressbar" aria-label={r.code+' assessed accuracy'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={r.percent}><div className="h-full bg-[var(--accent)]" style={{width:r.percent+'%'}}/></div>}
        {r.lectureIds.length>0&&<div className="mt-4 flex flex-wrap items-center gap-2"><span className="text-caption text-[var(--muted)]">Mapped lectures:</span>{r.lectureIds.map(id=><Link key={id} href={'/lecture/'+id} className="rounded-control border border-[var(--border)] px-3 py-1.5 text-caption font-semibold text-[var(--accent)] hover:bg-[var(--surface)]">Review lecture {id}</Link>)}</div>}
        {r.status==='NEEDS_REVISION'&&<p className="mt-3 text-caption text-[var(--muted)]">Review a mapped lecture before requesting another quiz.</p>}
      </article>)}
    </section>
    <p className="text-caption text-[var(--muted)] mt-5">At least three mapped graded answers are needed before a performance label is shown. These are learning indicators, not official university grades.</p>
    <Link href="/practice" className="inline-flex mt-5 items-center rounded-control bg-[var(--accent)] px-5 py-3 font-semibold text-white hover:bg-[var(--accent-deep)]">Practice another quiz</Link>
  </main>;
}
