'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery } from '@apollo/client';
import { GET_COURSES } from '@/graphql/course.queries';
import { GET_LECTURES } from '@/graphql/lecture.queries';
import { CREATE_PRACTICE_QUIZ, GET_PRACTICE_QUIZ, GET_PRACTICE_HISTORY, GET_PRACTICE_PROGRESS, SUBMIT_PRACTICE_QUIZ } from '@/graphql/practice.queries';
import { isLectureReady, sortLectures } from '@/lib/lectures';
import type { DBCourse } from '@/types/course';
import type { DBLecture } from '@/types';

type Item = {
  id: number; lectureId: number; lectureTitle: string; position: number; category: string;
  question: string; options: string[]; selectedIndex: number | null;
  correctIndex: number | null; isCorrect: boolean | null; explanation: string | null; source: string | null;
};
type LectureResult = {lectureId: number;lectureTitle: string;total: number;correct: number;incorrect: number;recommendation: string};
type Quiz = {id: number; courseId: number; status: string; total: number; correct: number | null; percent: number | null;
  questions: Item[]; breakdown: LectureResult[]; createdAt: string; submittedAt: string | null};
type Summary = {attempts: number;answered: number;correct: number;percent: number;lectures: {lectureId: number;lectureTitle:string;total:number;correct:number;percent:number}[]};
type PastQuiz = {id:number;courseId:number;total:number;correct:number|null;percent:number|null;status:string;createdAt:string};
const LETTERS=['A','B','C','D'];
const friendlyCategory=(category:string) => category.slice(0,1)+category.slice(1).toLowerCase();

export default function PracticePage() {
  const courses = useQuery(GET_COURSES);
  const lectures = useQuery(GET_LECTURES);
  const [courseId,setCourseId]=useState<number|null>(null);
  const [selected,setSelected]=useState<number[]>([]);
  const [activeId,setActiveId]=useState<number|null>(null);
  const [answers,setAnswers]=useState<Record<number,number>>({});
  const [localError,setLocalError]=useState('');
  const [pending,setPending]=useState(false);
  const [createQuiz]=useMutation(CREATE_PRACTICE_QUIZ);
  const [submitQuiz]=useMutation(SUBMIT_PRACTICE_QUIZ);
  const history=useQuery(GET_PRACTICE_HISTORY,{fetchPolicy:'network-only'});
  const progress=useQuery(GET_PRACTICE_PROGRESS,{fetchPolicy:'network-only'});
  const quizQuery=useQuery(GET_PRACTICE_QUIZ,{variables:{id:activeId??0},skip:activeId===null,fetchPolicy:'network-only'});
  const quiz:Quiz|undefined=quizQuery.data?.myPracticeQuiz;
  const isFinished=quiz?.status==='COMPLETED';
  const list:DBCourse[]=courses.data?.courses??[];
  const all:DBLecture[]=lectures.data?.lectures??[];
  const ready=useMemo(()=>sortLectures(all.filter(l=>Number(l.courseId)===courseId&&isLectureReady(l.status))),[all,courseId]);
  const course=list.find(c=>Number(c.id)===courseId);
  const completed=(history.data?.myPracticeQuizzes??[]) as PastQuiz[];
  const stats=progress.data?.myPracticeProgress as Summary|undefined;

  useEffect(()=>{
    if(courseId!==null||list.length===0)return;
    const params=new URLSearchParams(window.location.search);
    const fromUrl=Number(params.get('courseId'));
    setCourseId(list.some(c=>Number(c.id)===fromUrl)?fromUrl:Number(list[0].id));
  },[list,courseId]);

  useEffect(()=>{setSelected([]);},[courseId]);
  useEffect(()=>{
    if(!quiz)return;
    if(quiz.status==='READY')setAnswers({});
  },[quiz?.id,quiz?.status]);

  const reset=()=>{setActiveId(null);setAnswers({});setLocalError('');};
  const generate=async()=>{
    if(pending||!courseId||selected.length===0)return;
    setPending(true);setLocalError('');
    try{
      const result=await createQuiz({variables:{courseId,lectureIds:selected}});
      const created=result.data?.createPracticeQuiz as Quiz|undefined;
      if(!created)throw new Error('Quiz generation returned no questions.');
      setActiveId(created.id);setAnswers({});
      void history.refetch();
    }catch(e){setLocalError(e instanceof Error?e.message:'Could not create the quiz. Please try again.');}
    finally{setPending(false);}
  };
  const submit=async()=>{
    if(!quiz||pending||isFinished)return;
    const missing=quiz.questions.filter(q=>answers[q.id]===undefined);
    if(missing.length){setLocalError('Please answer all '+missing.length+' remaining question'+(missing.length===1?'':'s')+' before submitting.');return;}
    setPending(true);setLocalError('');
    try{
      const result=await submitQuiz({variables:{id:quiz.id,answers:quiz.questions.map(q=>({questionId:q.id,selectedIndex:answers[q.id]}))}});
      const submitted=result.data?.submitPracticeQuiz as Quiz|undefined;
      if(!submitted||submitted.status!=='COMPLETED')throw new Error('Unable to confirm submission.');
      await Promise.all([quizQuery.refetch(),history.refetch(),progress.refetch()]);
      window.scrollTo({top:0,behavior:'smooth'});
    }catch(e){setLocalError(e instanceof Error?e.message:'Could not submit your answers. Please try again.');}
    finally{setPending(false);}
  };
  const toggle=(id:number)=>{setSelected(current=>current.includes(id)?current.filter(x=>x!==id):[...current,id]);};
  const changeCourse=(id:number)=>{setCourseId(id);setLocalError('');};
  const loadingCourses=courses.loading||lectures.loading;
  const loadError=courses.error||lectures.error;
  const answered=quiz?.questions.filter(q=>answers[q.id]!==undefined).length??0;

  return (
    <main className="mx-auto max-w-[1180px] px-6 py-8">
      <div className="mb-7">
        <h1 className="text-h2 font-semibold text-[var(--text)]">Practice Quiz</h1>
        <p className="text-label text-[var(--muted)] mt-1">Practice what you have learned, review every answer, and see what to revise next.</p>
      </div>
      {localError&&<div role="alert" className="mb-5 rounded-card border border-red-200 bg-red-50 p-4 text-label text-red-700">{localError}</div>}
      {!activeId ? (
        <>
          {loadingCourses?<div className="p-10 text-[var(--muted)]">Loading your courses and lectures…</div>:
          loadError?<div role="alert" className="rounded-card border border-[var(--border)] bg-white p-6">Could not load courses. <button className="text-[var(--accent)] underline" onClick={()=>{void courses.refetch();void lectures.refetch();}}>Try again</button></div>:
          <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
            <section className="rounded-card border border-[var(--border)] bg-white p-6">
              <h2 className="text-h3 font-semibold text-[var(--text)] mb-4">Choose your lectures</h2>
              <label htmlFor="practice-course" className="block text-label font-medium text-[var(--muted)] mb-2">Course</label>
              <select id="practice-course" value={courseId??''} onChange={e=>changeCourse(Number(e.target.value))} className="h-11 w-full rounded-control border border-[var(--border)] bg-white px-3 text-body text-[var(--text)] mb-6">
                {list.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
              <div className="flex items-center justify-between gap-4 mb-3">
                <div>
                  <p className="text-label font-semibold text-[var(--text)]">{ready.length} tutor-ready lecture{ready.length===1?'':'s'}</p>
                  <p className="text-caption text-[var(--muted)]">Select any number of lectures from this course.</p>
                </div>
                <button disabled={!ready.length} onClick={()=>setSelected(selected.length===ready.length?[]:ready.map(l=>Number(l.id)))}
                  className="text-label font-semibold text-[var(--accent)] hover:underline disabled:opacity-50">
                  {selected.length===ready.length&&ready.length?'Clear all':'Select all'}
                </button>
              </div>
              {ready.length===0?<div className="rounded-card bg-[var(--surface)] p-5 text-label text-[var(--muted)]">No lectures with ready learning material in this course yet.</div>:
              <div className="divide-y divide-[var(--border)] border border-[var(--border)] rounded-card overflow-hidden">
                {ready.map(l=><label key={l.id} className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-[var(--surface)]">
                  <input type="checkbox" checked={selected.includes(Number(l.id))} onChange={()=>toggle(Number(l.id))} className="h-4 w-4 accent-[var(--accent)]" />
                  <span className="flex-1 text-label font-medium text-[var(--text)]">{l.title}</span>
                  <span className="text-caption text-[var(--muted)]">Ready</span>
                </label>)}
              </div>}
            </section>
            <aside className="rounded-card border border-[var(--border)] bg-white p-6 h-fit">
              <h2 className="text-h3 font-semibold text-[var(--text)]">Your practice</h2>
              <p className="text-caption text-[var(--muted)] mt-2">{selected.length} lecture{selected.length===1?'':'s'} selected</p>
              <div className="mt-5 rounded-card bg-[var(--surface)] p-4">
                <p className="text-label font-medium text-[var(--text)]">10 questions minimum</p>
                <p className="text-caption text-[var(--muted)] mt-1">A balanced mix of concepts, facts, scenarios and reasoning. Every selected lecture is included. No extra setup needed.</p>
              </div>
              <button type="button" onClick={generate} disabled={pending||selected.length===0} className="mt-5 h-11 w-full rounded-control bg-[var(--accent)] px-4 text-label font-semibold text-white hover:opacity-90 disabled:opacity-50">
                {pending?'Preparing your quiz…':'Generate Quiz'}
              </button>
              <p className="mt-3 text-caption text-[var(--muted)]">Your quiz is saved to your account. Answers are checked when you submit.</p>
            </aside>
          </div>}

          <div className="grid gap-5 lg:grid-cols-2 mt-5">
            <section className="rounded-card border border-[var(--border)] bg-white p-6">
              <h2 className="text-h3 font-semibold text-[var(--text)] mb-4">Your progress</h2>
              {progress.loading?<p className="text-label text-[var(--muted)]">Loading progress…</p>:progress.error?<p className="text-label text-red-600">Progress could not be loaded.</p>:stats?<>
                <div className="grid grid-cols-3 gap-3">
                  {[{label:'Quizzes',value:stats.attempts},{label:'Questions',value:stats.answered},{label:'Accuracy',value:stats.answered?stats.percent+'%':'—'}].map(s=>
                    <div key={s.label} className="rounded-card bg-[var(--surface)] p-3">
                      <p className="text-h3 font-semibold text-[var(--text)]">{s.value}</p><p className="text-caption text-[var(--muted)] mt-1">{s.label}</p>
                    </div>)}
                </div>
                {stats.lectures.length>0&&<div className="mt-4 space-y-3">
                  {stats.lectures.map(l=><div key={l.lectureId}>
                    <div className="flex justify-between gap-3 text-label mb-1"><span className="text-[var(--text)] truncate">{l.lectureTitle}</span><span className="text-[var(--muted)] shrink-0">{l.percent}%</span></div>
                    <div className="h-2 rounded-full bg-[var(--surface)] overflow-hidden"><div className="h-full rounded-full bg-[var(--accent)]" style={{width:l.percent+'%'}} /></div>
                  </div>)}
                </div>}
              </>:null}
            </section>
            <section className="rounded-card border border-[var(--border)] bg-white p-6">
              <h2 className="text-h3 font-semibold text-[var(--text)] mb-4">Recent quizzes</h2>
              {history.loading?<p className="text-label text-[var(--muted)]">Loading quizzes…</p>:history.error?<p className="text-label text-red-600">Quiz history could not be loaded.</p>:completed.length===0?<p className="text-label text-[var(--muted)]">No quizzes yet. Start your first practice quiz above.</p>:
              <div className="divide-y divide-[var(--border)]">{completed.slice(0,8).map(q=><button key={q.id} onClick={()=>{setActiveId(q.id);setLocalError('');window.scrollTo({top:0,behavior:'smooth'});}} className="w-full text-left py-3 flex items-center justify-between gap-3 hover:text-[var(--accent)]">
                <span><span className="block text-label font-medium">Quiz #{q.id}</span><span className="text-caption text-[var(--muted)]">{new Date(q.createdAt).toLocaleDateString()} · {q.total} questions</span></span>
                <span className="text-label font-semibold text-[var(--text)] shrink-0">{q.status==='COMPLETED'?q.percent+'%':'Resume'} <i className="fas fa-chevron-right ml-2 text-xs"/></span>
              </button>)}</div>}
            </section>
          </div>
        </>
      ):quizQuery.loading&&!quiz?<div className="rounded-card border border-[var(--border)] bg-white p-10 text-center text-label text-[var(--muted)]">Loading quiz…</div>:
        quizQuery.error||!quiz?<div role="alert" className="rounded-card border border-[var(--border)] bg-white p-6"><p className="text-label text-red-600">This quiz could not be loaded.</p><button onClick={reset} className="text-label text-[var(--accent)] mt-3">Back to practice</button></div>:
        <div className="max-w-[900px] mx-auto">
          <button onClick={reset} className="text-label text-[var(--accent)] font-semibold hover:underline mb-5"><i className="fas fa-arrow-left mr-2"/>Back to practice</button>
          <section className="rounded-card border border-[var(--border)] bg-white p-6 mb-5">
            {isFinished?<div>
              <p className="text-label font-semibold text-[var(--accent)] mb-2">Practice complete</p>
              <h2 className="text-h1 font-semibold text-[var(--text)]">{quiz.correct} / {quiz.total} correct <span className="text-h3 text-[var(--muted)]">({quiz.percent}%)</span></h2>
              <p className="text-label text-[var(--muted)] mt-2">Review the questions below. Your score and lecture-wise recommendations are saved.</p>
            </div>:<div>
              <h2 className="text-h3 font-semibold text-[var(--text)]">{course?.title??'Practice Quiz'}</h2>
              <p className="text-label text-[var(--muted)] mt-2">{answered} of {quiz.total} questions answered · One answer for each question</p>
              <div className="h-2 rounded-full bg-[var(--surface)] overflow-hidden mt-4"><div className="h-full bg-[var(--accent)] transition-all" style={{width:quiz.total?answered/quiz.total*100+'%':'0%'}}/></div>
            </div>}
          </section>
          {isFinished&&<section className="rounded-card border border-[var(--border)] bg-white p-6 mb-5">
            <h2 className="text-h3 font-semibold text-[var(--text)] mb-4">What to revise</h2>
            <div className="space-y-4">{quiz.breakdown.map(b=><div key={b.lectureId} className="rounded-card bg-[var(--surface)] p-4">
              <div className="flex items-center justify-between gap-4">
                <p className="text-label font-semibold text-[var(--text)]">{b.lectureTitle}</p>
                <span className="text-label font-semibold text-[var(--text)] shrink-0">{b.correct}/{b.total}</span>
              </div>
              <p className="text-label text-[var(--muted)] mt-2">{b.recommendation}</p>
              {b.incorrect>0&&<Link className="inline-flex mt-3 text-label font-semibold text-[var(--accent)] hover:underline" href={'/lecture/'+b.lectureId}>Review lecture <i className="fas fa-arrow-right ml-2 self-center text-xs"/></Link>}
            </div>)}</div>
          </section>}
          <div className="space-y-4">
            {quiz.questions.map((q,index)=>{
              const chosen=isFinished?q.selectedIndex:answers[q.id];
              return <section key={q.id} className="rounded-card border border-[var(--border)] bg-white p-6">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                  <span className="text-caption font-semibold text-[var(--muted)]">Question {index+1} of {quiz.total}</span>
                  <span className="text-caption text-[var(--muted)]">{q.lectureTitle} · {friendlyCategory(q.category)}</span>
                </div>
                <h3 className="text-body font-semibold text-[var(--text)] leading-relaxed">{q.question}</h3>
                <div className="mt-4 space-y-2">{q.options.map((option,i)=>{
                  const selected=chosen===i;
                  const correct=isFinished&&q.correctIndex===i;
                  const wrong=isFinished&&selected&&!correct;
                  const style=correct?'border-[var(--accent)] bg-[var(--accent-soft)]':wrong?'border-red-300 bg-red-50':selected?'border-[var(--accent)] bg-[var(--surface)]':'border-[var(--border)] hover:bg-[var(--surface)]';
                  return <label key={i} className={'flex items-start gap-3 rounded-control border p-3 transition-colors '+style+(isFinished?' cursor-default':' cursor-pointer')}>
                    <input type="radio" name={'practice-'+q.id} value={i} disabled={isFinished||pending} checked={selected} onChange={()=>setAnswers(prev=>({...prev,[q.id]:i}))} className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"/>
                    <span className="text-label text-[var(--text)]"><span className="font-semibold mr-2">{LETTERS[i]}.</span>{option}</span>
                    {isFinished&&correct&&<span className="ml-auto text-[var(--accent)] text-caption font-semibold">Correct</span>}
                    {isFinished&&wrong&&<span className="ml-auto text-red-600 text-caption font-semibold">Your answer</span>}
                  </label>;
                })}</div>
                {isFinished&&<div className="mt-4 border-t border-[var(--border)] pt-4">
                  <p className={'text-label font-semibold '+(q.isCorrect?'text-[var(--accent)]':'text-red-600')}>{q.isCorrect?'Answered correctly':'Needs revision'}</p>
                  <p className="text-label text-[var(--text)] mt-2">{q.explanation}</p>
                  <p className="text-caption text-[var(--muted)] mt-2">Source: {q.source}</p>
                </div>}
              </section>;
            })}
          </div>
          {!isFinished&&<div className="mt-6 flex flex-wrap justify-between items-center gap-3">
            <p className="text-label text-[var(--muted)]">{answered}/{quiz.total} answered</p>
            <button disabled={pending||answered!==quiz.total} onClick={submit} className="h-11 rounded-control bg-[var(--accent)] px-7 text-label font-semibold text-white disabled:opacity-50 hover:opacity-90">
              {pending?'Submitting…':'Submit answers'}
            </button>
          </div>}
          {isFinished&&<div className="mt-6 text-center"><button onClick={reset} className="h-11 rounded-control bg-[var(--accent)] px-7 text-label font-semibold text-white hover:opacity-90">Back to practice</button></div>}
        </div>}
    </main>
  );
}
