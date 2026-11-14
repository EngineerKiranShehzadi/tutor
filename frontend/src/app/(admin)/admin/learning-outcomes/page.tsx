'use client';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { AdminPageHero } from '@/components/admin/AdminPageHero';
import { MisconceptionReview } from '@/components/admin/MisconceptionReview';
import { GET_COURSES } from '@/graphql/course.queries';
import { GET_LECTURES } from '@/graphql/lecture.queries';
import {
  GET_LEARNING_OUTCOMES, GET_FACULTY_OUTCOME_SUMMARY, GET_OUTCOME_QUESTIONS,
  CREATE_LEARNING_OUTCOME, UPDATE_LEARNING_OUTCOME, SET_LECTURE_LEARNING_OUTCOME,
  MAP_PRACTICE_QUESTION_OUTCOME, UNMAP_PRACTICE_QUESTION_OUTCOME,
} from '@/graphql/learning-outcome.queries';

type Course = {id:string;title:string};
type Lecture = {id:string;courseId:string;title:string};
type Outcome = {id:number;code:string;description:string;lectureIds:number[]};
type Question = {questionId:number;lectureId:number;lectureTitle:string;question:string;outcomeId:number|null};
type Summary = {outcomeId:number;code:string;attempted:number;correct:number;students:number;percent:number|null};
const input = 'w-full rounded-control border border-[var(--border)] bg-[var(--card)] px-3.5 py-2.5 text-label text-[var(--text)] focus:border-[var(--accent)] outline-none';
const button = 'rounded-control bg-[var(--accent)] px-4 py-2 text-label font-semibold text-white hover:bg-[var(--accent-deep)] disabled:opacity-50';
const outline = 'rounded-control border border-[var(--border)] px-3 py-1.5 text-caption text-[var(--text)] hover:bg-[var(--surface)] disabled:opacity-50';
export default function LearningOutcomesAdmin() {
  const courses = useQuery(GET_COURSES,{variables:{includeArchived:false},fetchPolicy:'cache-and-network'});
  const lectures = useQuery(GET_LECTURES,{fetchPolicy:'cache-and-network'});
  const allCourses:Course[]=courses.data?.courses??[];
  const allLectures:Lecture[]=lectures.data?.lectures??[];
  const [courseId,setCourseId]=useState<number|null>(null);
  const [code,setCode]=useState('');
  const [description,setDescription]=useState('');
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [pending,setPending]=useState(false);
  const [showQuestions,setShowQuestions]=useState(false);
  useEffect(()=>{
    if(allCourses.length===0)return;
    if(courseId!==null&&allCourses.some(c=>Number(c.id)===courseId))return;
    setCourseId(Number(allCourses[0].id));
  },[allCourses,courseId]);
  const skip=courseId===null;
  const outcomesQuery=useQuery(GET_LEARNING_OUTCOMES,{variables:{courseId:courseId??0},skip,fetchPolicy:'cache-and-network'});
  const summaryQuery=useQuery(GET_FACULTY_OUTCOME_SUMMARY,{variables:{courseId:courseId??0},skip,fetchPolicy:'cache-and-network'});
  const questionsQuery=useQuery(GET_OUTCOME_QUESTIONS,{variables:{courseId:courseId??0,limit:50},skip:skip||!showQuestions,fetchPolicy:'cache-and-network'});
  const [create]=useMutation(CREATE_LEARNING_OUTCOME);
  const [update]=useMutation(UPDATE_LEARNING_OUTCOME);
  const [setLecture]=useMutation(SET_LECTURE_LEARNING_OUTCOME);
  const [mapQuestion]=useMutation(MAP_PRACTICE_QUESTION_OUTCOME);
  const [unmapQuestion]=useMutation(UNMAP_PRACTICE_QUESTION_OUTCOME);
  const outcomes:Outcome[]=outcomesQuery.data?.courseLearningOutcomes??[];
  const summaries:Summary[]=summaryQuery.data?.facultyOutcomeSummary??[];
  const questions:Question[]=questionsQuery.data?.learningOutcomeQuestions??[];
  const summaryById=useMemo(()=>new Map(summaries.map(s=>[s.outcomeId,s])),[summaries]);
  const courseLectures=allLectures.filter(l=>Number(l.courseId)===courseId);
  async function execute(action:()=>Promise<unknown>,msg:string){
    if(pending)return;
    setError('');setNotice('');setPending(true);
    try{
      await action();
      await Promise.all([outcomesQuery.refetch(),summaryQuery.refetch(),...(showQuestions?[questionsQuery.refetch()]:[])]);
      setNotice(msg);
    }catch(e){setError(e instanceof Error?e.message:'Could not save changes.');}
    finally{setPending(false);}
  }
  async function save(e:React.FormEvent){
    e.preventDefault();
    if(courseId===null)return;
    await execute(()=>create({variables:{courseId,code:code.trim(),description:description.trim()}}),'Learning outcome saved.');
    // Reset only on a confirmed success; execute handles the errors.
  }
  return <div className="max-w-[1180px]">
    <AdminPageHero title="Learning Outcomes" subtitle="Map course goals to lectures and reviewed quiz questions. Progress is based only on graded evidence."/>
    <div className="mb-5 rounded-card border border-[var(--border)] bg-[var(--card)] p-5">
      <label htmlFor="outcome-course" className="block text-label font-semibold text-[var(--text)] mb-2">Course</label>
      <select id="outcome-course" className={input} value={courseId??''} onChange={e=>{setCourseId(Number(e.target.value));setNotice('');setError('');}}>
        {allCourses.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}
      </select>
    </div>
    {error&&<p role="alert" className="mb-4 rounded-card border border-[var(--border)] border-l-[3px] border-l-red-600 bg-[var(--card)] p-4 text-label text-[var(--text)]">{error}</p>}
    {notice&&<p role="status" className="mb-4 rounded-card border border-[var(--border)] border-l-[3px] border-l-[var(--accent)] bg-[var(--card)] p-4 text-label text-[var(--text)]">{notice}</p>}
    <div className="rounded-card border border-[var(--border)] bg-[var(--card)] p-6 mb-5">
      <h2 className="text-h3 font-semibold text-[var(--text)] mb-2">Add a course learning outcome</h2>
      <p className="text-caption text-[var(--muted)] mb-4">Use a stable code, such as CLO1. This record is English-only for the current pilot.</p>
      <form onSubmit={save} className="grid gap-3">
        <label className="text-label text-[var(--text)]">Outcome code
          <input required maxLength={32} value={code} onChange={e=>setCode(e.target.value)} placeholder="CLO1" className={input+' mt-1'}/>
        </label>
        <label className="text-label text-[var(--text)]">Learning objective
          <textarea required minLength={5} maxLength={1000} rows={2} value={description} onChange={e=>setDescription(e.target.value)} placeholder="Explain the key principles of..." className={input+' mt-1'}/>
        </label>
        <div><button className={button} disabled={pending||skip} type="submit">Add outcome</button></div>
      </form>
    </div>
    <section className="space-y-4" aria-label="Learning outcomes">
      {outcomesQuery.loading&&!outcomes.length&&<p role="status" className="text-label text-[var(--muted)]">Loading outcomes…</p>}
      {outcomesQuery.error&&<p role="alert" className="text-label text-[var(--text)]">Could not load outcomes; apply migration 033 to your development database first.</p>}
      {!outcomesQuery.loading&&!outcomes.length&&<p className="text-label text-[var(--muted)]">No learning outcomes defined for this course yet.</p>}
      {outcomes.map(o=>{
        const s=summaryById.get(o.id);
        return <article key={o.id} className="rounded-card border border-[var(--border)] bg-[var(--card)] p-5">
          <div className="flex flex-wrap gap-3 justify-between">
            <div className="min-w-0"><h2 className="text-h3 font-semibold text-[var(--text)]">{o.code}</h2><p className="text-label text-[var(--text)] mt-1">{o.description}</p></div>
            <button type="button" className={outline} disabled={pending} onClick={()=>{
              const value=window.prompt('Edit the outcome description',o.description);
              if(value!==null)void execute(()=>update({variables:{id:o.id,description:value}}),'Description updated.');
            }}>Edit description</button>
          </div>
          <p className="text-caption text-[var(--muted)] mt-3">Mapped graded answers: {s?.attempted??0} · Correct: {s?.correct??0} · Students: {s?.students??0} · Accuracy: {s?.percent==null?'Not assessed':s.percent+'%'}</p>
          <fieldset className="mt-4 border-t border-[var(--border)] pt-3">
            <legend className="text-label font-semibold text-[var(--text)] pt-3">Lectures covering {o.code}</legend>
            <div className="flex flex-wrap gap-4 mt-2">
              {courseLectures.map(l=><label key={l.id} className="inline-flex items-center gap-2 text-label text-[var(--text)]">
                <input type="checkbox" disabled={pending} checked={o.lectureIds.includes(Number(l.id))} onChange={e=>{
                  if(courseId===null)return;
                  void execute(()=>setLecture({variables:{courseId,lectureId:Number(l.id),outcomeId:o.id,selected:e.target.checked}}),'Lecture mapping updated.');
                }}/>{l.title}
              </label>)}
            </div>
            {!courseLectures.length&&<p className="text-caption text-[var(--muted)]">Add a lecture to this course before mapping.</p>}
          </fieldset>
        </article>;
      })}
    </section>
    <section className="rounded-card border border-[var(--border)] bg-[var(--card)] p-5 mt-5">
      <div className="flex flex-wrap gap-3 justify-between items-center">
        <div><h2 className="text-h3 font-semibold text-[var(--text)]">Review quiz evidence mappings</h2><p className="text-caption text-[var(--muted)] mt-1">Question-level tags require manual review. A lecture's CLO mapping does not automatically tag its MCQs.</p></div>
        <button type="button" className={outline} onClick={()=>setShowQuestions(v=>!v)}>{showQuestions?'Hide questions':'Review latest 50 questions'}</button>
      </div>
      {showQuestions&&<div className="mt-4 space-y-3">
        {questionsQuery.loading&&!questions.length&&<p role="status" className="text-label text-[var(--muted)]">Loading questions…</p>}
        {questionsQuery.error&&<p role="alert" className="text-label text-[var(--text)]">Could not load quiz questions.</p>}
        {questions.map(q=><div key={q.questionId} className="border-t border-[var(--border)] py-3">
          <p className="text-caption text-[var(--muted)]">{q.lectureTitle} · Question #{q.questionId}</p>
          <p className="text-label text-[var(--text)] mt-1 mb-2">{q.question}</p>
          <label className="text-caption text-[var(--muted)]">Approved outcome
            <select className={input+' mt-1'} disabled={pending} value={q.outcomeId??''} onChange={e=>{
              if(courseId===null)return;
              const value=e.target.value;
              void execute(()=>value?mapQuestion({variables:{courseId,questionId:q.questionId,outcomeId:Number(value)}}):unmapQuestion({variables:{courseId,questionId:q.questionId}}),'Question mapping updated.');
            }}>
              <option value="">Not mapped</option>
              {outcomes.map(o=><option key={o.id} value={o.id}>{o.code} — {o.description.slice(0,75)}</option>)}
            </select>
          </label>
        </div>)}
        {!questionsQuery.loading&&!questions.length&&<p className="text-label text-[var(--muted)]">No generated quiz questions found for this course.</p>}
      </div>}
    </section>
    {courseId!==null&&<MisconceptionReview courseId={courseId} outcomes={outcomes}/>}
    <p className="mt-4 text-caption text-[var(--muted)]">Assessment status is descriptive, not a validated psychometric mastery score. LMS/CASE integrations are not enabled.</p>
  </div>;
}
