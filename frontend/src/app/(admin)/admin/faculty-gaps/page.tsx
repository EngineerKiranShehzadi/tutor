'use client';
import {useEffect,useState} from 'react';
import Link from 'next/link';
import {useQuery} from '@apollo/client';
import {AdminPageHero} from '@/components/admin/AdminPageHero';
import {FacultyRevisionEditor} from '@/components/admin/FacultyRevisionEditor';
import {GET_COURSES} from '@/graphql/course.queries';
import {GET_FACULTY_LEARNING_GAPS} from '@/graphql/faculty-learning-gaps.queries';

type Course={id:string;title:string};
type Gap={outcomeId:number;code:string;description:string;mappedQuestions:number;
 assessedStudents:number|null;eligibleStudents:number|null;revisionStudents:number|null;
 answerAccuracyPercent:number|null;revisionPercent:number|null;lectureIds:number[];
 status:string;recommendation:string};
const labels:Record<string,string>={NOT_MAPPED:'Question mapping needed',INSUFFICIENT_EVIDENCE:'More evidence needed',REVIEW_RECOMMENDED:'Admin review recommended',MONITOR:'Monitor'};
export default function FacultyLearningGaps(){
 const courses=useQuery(GET_COURSES,{variables:{includeArchived:false},fetchPolicy:'cache-and-network'});
 const [courseId,setCourseId]=useState<number|null>(null);
 const list:Course[]=courses.data?.courses??[];
 useEffect(()=>{
  if(!list.length)return;
  if(courseId!==null&&list.some(c=>Number(c.id)===courseId))return;
  setCourseId(Number(list[0].id));
 },[list,courseId]);
 const query=useQuery(GET_FACULTY_LEARNING_GAPS,{variables:{courseId:courseId??0},skip:courseId===null,fetchPolicy:'cache-and-network'});
 const rows:Gap[]=query.data?.facultyLearningGaps??[];
 const review=rows.filter(x=>x.status==='REVIEW_RECOMMENDED').length;
 const insufficient=rows.filter(x=>x.status==='INSUFFICIENT_EVIDENCE'||x.status==='NOT_MAPPED').length;
 return <div className="learning-form-a11y max-w-[1180px]">
  <AdminPageHero title="Learning Gaps"
   subtitle="Evidence-based review of course learning outcomes. No student identity or automated academic decisions."/>
  <section className="bg-[var(--card)] rounded-card border border-[var(--border)] p-5 mb-5">
   <label htmlFor="faculty-gap-course" className="block text-label font-semibold text-[var(--text)] mb-2">Course</label>
   <select id="faculty-gap-course" value={courseId??''} onChange={e=>setCourseId(Number(e.target.value))}
    className="w-full rounded-control border border-[var(--border)] bg-[var(--card)] px-3.5 py-2.5 text-label text-[var(--text)] focus:border-[var(--accent)]">
    {list.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}
   </select>
  </section>
  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
   {[{label:'Mapped learning outcomes',value:String(rows.filter(x=>x.mappedQuestions>0).length)},
     {label:'Admin review suggested',value:String(review)},
     {label:'Not yet sufficiently assessed',value:String(insufficient)}].map(s=>
     <section key={s.label} className="rounded-card border border-[var(--border)] bg-[var(--card)] p-5">
      <p className="text-h1 font-semibold text-[var(--text)]">{s.value}</p>
      <p className="text-caption text-[var(--muted)] mt-2">{s.label}</p>
     </section>)}
  </div>
  {query.loading&&!query.data&&<p role="status" className="text-label text-[var(--muted)]">Loading course learning evidence…</p>}
  {query.error&&<section role="alert" className="bg-[var(--card)] rounded-card border border-[var(--border)] p-5">
   <p className="text-label text-[var(--text)]">Could not load learning-gap analytics.</p>
   <button type="button" onClick={()=>void query.refetch()} className="mt-2 text-[var(--accent)] font-semibold text-label underline">Retry</button>
  </section>}
  {!query.loading&&!query.error&&!rows.length&&<section className="rounded-card bg-[var(--card)] border border-[var(--border)] p-6">
   <p className="text-label text-[var(--text)]">No CLOs are defined for this course yet.</p>
   <Link href="/admin/learning-outcomes" className="inline-block mt-3 text-label font-semibold text-[var(--accent)] hover:underline">Manage learning outcomes</Link>
  </section>}
  <div className="space-y-4">
   {rows.map(x=><article key={x.outcomeId} className="bg-[var(--card)] rounded-card border border-[var(--border)] p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
     <div className="flex-1 min-w-0">
      <h2 className="text-h3 font-semibold text-[var(--text)]">{x.code}</h2>
      <p className="text-label text-[var(--text)] mt-1">{x.description}</p>
     </div>
     <span className="rounded-full px-3 py-1 border border-[var(--border)] text-caption font-semibold bg-[var(--surface)] text-[var(--text)]">
      {labels[x.status]??x.status}
     </span>
    </div>
    <p className="text-caption text-[var(--muted)] mt-4">{x.mappedQuestions} admin-reviewed quiz questions</p>
    {x.eligibleStudents===null?
     <p className="mt-2 text-label text-[var(--muted)]">Cohort performance is hidden until at least five students each have three mapped graded answers.</p>:
     <div className="mt-3">
      <div className="flex flex-wrap gap-5 text-label text-[var(--text)]">
       <span>{x.eligibleStudents} sufficiently assessed students</span>
       <span>{x.revisionStudents} with low observed quiz accuracy</span>
       <span>{x.revisionPercent}% of sufficiently assessed students</span>
      </div>
      {x.revisionPercent!==null&&<div role="progressbar" aria-label={x.code+' low assessment accuracy proportion'}
       aria-valuenow={x.revisionPercent} aria-valuemin={0} aria-valuemax={100}
       className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface)] border border-[var(--border)]">
       <div style={{width:x.revisionPercent+'%'}} className="h-full rounded-full bg-[var(--accent)]"/>
      </div>}
     </div>}
    {courseId!==null&&<FacultyRevisionEditor courseId={courseId} outcomeId={x.outcomeId} code={x.code} lectureIds={x.lectureIds}/>}
    <div className="mt-4 pt-4 border-t border-[var(--border)]">
     <p className="text-caption font-semibold text-[var(--text)]">Suggested admin action</p>
     <p className="text-label text-[var(--muted)] mt-1">{x.recommendation}</p>
     <div className="flex gap-3 flex-wrap mt-3">
      <Link href="/admin/learning-outcomes" className="text-caption font-semibold text-[var(--accent)] hover:underline">Review CLO mappings</Link>
      {x.lectureIds.length>0&&<Link href="/admin/lectures" className="text-caption font-semibold text-[var(--accent)] hover:underline">Review mapped lectures</Link>}
     </div>
    </div>
   </article>)}
  </div>
  <p className="mt-6 text-caption text-[var(--muted)]">These indicators describe completed, admin-mapped quizzes only; they are not official grades, validated mastery scores, or automated early-warning predictions. Admin decides whether any intervention is appropriate.</p>
 </div>;
}
