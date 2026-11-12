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
  const quizQuery=useQuery(GET_PRACTICE_QUIZ,{variables:{id:activeId??0},skip:activeId===null,fetchPolicy:'cache-first'});
  const quiz:Quiz|undefined=quizQuery.data?.myPracticeQuiz;
  const isFinished=quiz?.status==='COMPLETED';
  const list:DBCourse[]=courses.data?.courses??[];
  const all:DBLecture[]=lectures.data?.lectures??[];
  const visible=useMemo(()=>sortLectures(all.filter(l=>Number(l.courseId)===courseId)),[all,courseId]);
  const ready=visible.filter(l=>isLectureReady(l.status));
  const course=list.find(c=>Number(c.id)===courseId);
  const completed=(history.data?.myPracticeQuizzes??[]) as PastQuiz[];

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
      const result=await createQuiz({
        variables:{courseId,lectureIds:selected},
        update(cache,{data}) {
          const created=data?.createPracticeQuiz as Quiz|undefined;
          if(created) cache.writeQuery({
            query:GET_PRACTICE_QUIZ,
            variables:{id:created.id},
            data:{myPracticeQuiz:created},
          });
        },
      });
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
  // Same lectures, a fresh set of questions. The lecture ids come from the
  // finished quiz's own breakdown, so a retake cannot silently widen or narrow
  // what the student chose the first time.
  const retake=async()=>{
    if(!quiz||pending)return;
    const lectureIds=quiz.breakdown.map(b=>b.lectureId);
    if(lectureIds.length===0)return;
    setPending(true);setLocalError('');
    try{
      const result=await createQuiz({
        variables:{courseId:quiz.courseId,lectureIds},
        update(cache,{data}) {
          const created=data?.createPracticeQuiz as Quiz|undefined;
          if(created) cache.writeQuery({
            query:GET_PRACTICE_QUIZ,
            variables:{id:created.id},
            data:{myPracticeQuiz:created},
          });
        },
      });
      const created=result.data?.createPracticeQuiz as Quiz|undefined;
      if(!created)throw new Error('Quiz generation returned no questions.');
      setActiveId(created.id);setAnswers({});
      window.scrollTo({top:0,behavior:'smooth'});
      void history.refetch();
    }catch(e){setLocalError(e instanceof Error?e.message:'Could not create the quiz. Please try again.');}
    finally{setPending(false);}
  };
  const toggle=(id:number)=>{setSelected(current=>current.includes(id)?current.filter(x=>x!==id):[...current,id]);};
  const changeCourse=(id:number)=>{setCourseId(id);setLocalError('');};
  const loadingCourses=courses.loading||lectures.loading;
  const loadError=courses.error||lectures.error;
  const answered=quiz?.questions.filter(q=>answers[q.id]!==undefined).length??0;
  const answeredPercent=quiz&&quiz.total?Math.round(answered/quiz.total*100):0;

  return (
    <main className="mx-auto max-w-[1180px] px-6 py-8">
      {/* Plain heading, no icon tile: Courses and My Activity open the same
          way, and a tinted square here made this one page look decorated. */}
      <div className="mb-7">
        <h1 className="text-h2 font-semibold text-[var(--text)]">Practice Quiz</h1>
        <p className="text-label text-[var(--muted)] mt-1">Practice what you have learned, review every answer, and see what to revise next.</p>
      </div>
      {localError&&<div role="alert" className="mb-5 rounded-card border border-red-200 bg-red-50 p-4 text-label text-red-700">{localError}</div>}
      {!activeId ? (
        <>
          {loadingCourses?<div className="p-10 text-[var(--muted)]">Loading your courses and lectures…</div>:
          loadError?<div role="alert" className="rounded-card border border-[var(--border)] bg-white p-6">Could not load courses. <button className="text-[var(--accent)] underline" onClick={()=>{void courses.refetch();void lectures.refetch();}}>Try again</button></div>:
          <div className="grid gap-5 lg:grid-cols-[1fr_320px] items-start">
            <section className="rounded-card border border-[var(--border)] bg-white p-6">
              <h2 className="text-h3 font-semibold text-[var(--text)] mb-4">Select Lectures</h2>
              <label htmlFor="practice-course" className="block text-label font-medium text-[var(--muted)] mb-2">Course</label>
              <select id="practice-course" value={courseId??''} onChange={e=>changeCourse(Number(e.target.value))} className="h-11 w-full rounded-control border border-[var(--border)] bg-white px-3 text-body text-[var(--text)] mb-6">
                {list.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
              <div className="flex items-center justify-between gap-4 mb-3">
                <div>
                  <p className="text-label font-semibold text-[var(--text)]">{ready.length} of {visible.length} lecture{visible.length===1?'':'s'} ready</p>
                  <p className="text-caption text-[var(--muted)]">Select any number of lectures from this course.</p>
                </div>
                <button disabled={!ready.length} onClick={()=>setSelected(selected.length===ready.length?[]:ready.map(l=>Number(l.id)))}
                  className="h-9 px-3 rounded-control border border-[var(--border)] text-label font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:opacity-50 shrink-0">
                  {selected.length===ready.length&&ready.length?'Clear all':'Select all'}
                </button>
              </div>
              {visible.length===0?<div className="rounded-card bg-[var(--surface)] p-5 text-label text-[var(--muted)]">No lectures have been added to this course yet.</div>:
              <div className="space-y-2">
                {visible.map((l,index)=>{
                  const selectable=isLectureReady(l.status);
                  const isSelected=selected.includes(Number(l.id));
                  const rowStyle=!selectable
                    ? 'border-[var(--border)] bg-[var(--surface)] opacity-55 cursor-not-allowed'
                    : isSelected
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] cursor-pointer'
                    : 'border-[var(--border)] bg-white hover:bg-[var(--surface)] cursor-pointer';
                  return <label key={l.id} className={'flex items-center gap-3 rounded-card border px-4 py-3 transition-colors '+rowStyle}>
                    <input type="checkbox" disabled={!selectable} checked={isSelected} onChange={()=>toggle(Number(l.id))} className="sr-only" />
                    <span className={'w-5 h-5 rounded-[5px] border flex items-center justify-center shrink-0 '+(isSelected?'bg-[var(--accent)] border-[var(--accent)] text-white':'bg-white border-[var(--border)]')}>
                      {isSelected&&<i className="fas fa-check text-[10px]" />}
                    </span>
                    <span className="w-6 text-caption font-semibold text-[var(--muted2)] text-center shrink-0">{index+1}</span>
                    <span className="flex-1 text-label font-medium text-[var(--text)]">{l.title}</span>
                    {/* Ready is the ordinary case for every row, so saying it on
                        each one is noise. Only the exception is labelled. */}
                    {!selectable&&<span className="text-caption text-[var(--muted)] shrink-0">Material not ready</span>}
                  </label>;
                })}
              </div>}
            </section>
            <aside className="rounded-card border border-[var(--border)] bg-white p-6 h-fit lg:sticky lg:top-6">
              <h2 className="text-h3 font-semibold text-[var(--text)]">Start a Quiz</h2>
              <div className="mt-4 flex items-baseline gap-2">
                <span className="text-display font-semibold text-[var(--accent)] leading-none">{selected.length}</span>
                <span className="text-label text-[var(--muted)]">lecture{selected.length===1?'':'s'} selected</span>
              </div>
              {/* The count is fixed in the backend, so this no longer offers a
                  choice the student does not have. */}
              <div className="mt-5 rounded-card bg-[var(--surface)] p-4">
                <p className="text-label font-medium text-[var(--text)]">Each quiz has 10 questions</p>
                <p className="text-caption text-[var(--muted)] mt-1">A balanced mix of concepts, facts, scenarios and reasoning, spread across every lecture you select.</p>
              </div>
              <button type="button" onClick={generate} disabled={pending||selected.length===0} className="mt-5 h-11 w-full rounded-control bg-[var(--accent)] px-4 text-label font-semibold text-white hover:bg-[var(--accent-deep)] active:scale-[0.99] transition disabled:opacity-50 disabled:hover:bg-[var(--accent)]">
                {pending?'Preparing your quiz…':'Generate Quiz'}
              </button>
              <p className="mt-3 text-caption text-[var(--muted)]">
                {selected.length===0?'Select at least one lecture to generate a quiz.':'Your quiz is saved to your account. Answers are checked when you submit.'}
              </p>
            </aside>
          </div>}

          {/* Lifetime totals used to sit beside this card. They answer "how am
              I doing overall", which is what My Activity is for, and having
              both a lifetime panel and a per-quiz panel on one screen was the
              main reason this page read as a wall of boxes. */}
          <div className="mt-5">
            <section className="rounded-card border border-[var(--border)] bg-white p-6">
              <div className="flex items-baseline justify-between gap-3 mb-4">
                <h2 className="text-h3 font-semibold text-[var(--text)]">Recent Quizzes</h2>
                <Link href="/profile/activity" className="text-label font-semibold text-[var(--accent)] hover:underline">See My Activity</Link>
              </div>
              {history.loading?<p className="text-label text-[var(--muted)]">Loading quizzes…</p>:history.error?<p className="text-label text-red-600">Quiz history could not be loaded.</p>:completed.length===0?<p className="text-label text-[var(--muted)]">No quizzes yet. Start your first practice quiz above.</p>:
              <div className="space-y-2">{completed.slice(0,8).map((q,i)=><button key={q.id} onClick={()=>{setActiveId(q.id);setLocalError('');window.scrollTo({top:0,behavior:'smooth'});}} className="w-full text-left rounded-card border border-[var(--border)] bg-white px-4 py-3 flex items-center justify-between gap-3 hover:bg-[var(--surface)] transition-colors">
                {/* The row used to be titled "Quiz #<id>". That id is a database
                    row number shared by every quiz in the system, including ones
                    that failed to generate, so it jumps and means nothing to the
                    student. The date is what they actually recognise. */}
                {/* Counted from this student's own list, oldest first, so the
                    first quiz they ever generated is Quiz 1. The database id was
                    shared with every other student and skipped numbers. */}
                <span className="min-w-0">
                  <span className="block text-label font-medium text-[var(--text)]">Quiz {completed.length-i}</span>
                  <span className="text-caption text-[var(--muted)]">{new Date(q.createdAt).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'})}</span>
                </span>
                <span className="flex items-center gap-2.5 shrink-0">
                  {q.status==='COMPLETED'
                    ? <span className="text-label font-semibold text-[var(--text)]">{q.percent}%</span>
                    : <span className="text-caption text-[var(--muted)]">Not finished</span>}
                  <i className="fas fa-chevron-right text-[11px] text-[var(--muted2)]"/>
                </span>
              </button>)}</div>}
            </section>
          </div>
        </>
      ):quizQuery.loading&&!quiz?<div className="rounded-card border border-[var(--border)] bg-white p-10 text-center text-label text-[var(--muted)]">Loading quiz…</div>:
        quizQuery.error||!quiz?<div role="alert" className="rounded-card border border-[var(--border)] bg-white p-6"><p className="text-label text-red-600">This quiz could not be loaded.</p><button onClick={reset} className="text-label text-[var(--accent)] mt-3">Back to practice</button></div>:
        <div className="max-w-[900px] mx-auto">
          <button onClick={reset} className="text-label text-[var(--accent)] font-semibold hover:underline mb-5"><i className="fas fa-arrow-left mr-2"/>Back to Practice</button>
          {isFinished?
            <section className="rounded-card border border-[var(--border)] bg-white p-6 mb-5 flex flex-wrap items-center gap-6">
              <div className="relative w-[108px] h-[108px] shrink-0">
                <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                  <circle cx="18" cy="18" r="15.915" fill="none" stroke="var(--border)" strokeWidth="3" />
                  <circle cx="18" cy="18" r="15.915" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeDasharray={(quiz.percent??0)+' 100'} />
                </svg>
                <span className="absolute inset-0 flex items-center justify-center text-h2 font-semibold text-[var(--text)]">{quiz.percent}%</span>
              </div>
              <div className="min-w-0">
                <p className="text-label font-semibold text-[var(--accent)] mb-1">Practice complete</p>
                <h2 className="text-h1 font-semibold text-[var(--text)]">{quiz.correct} / {quiz.total} correct</h2>
                <p className="text-label text-[var(--muted)] mt-2">Review the questions below. Your score and lecture-wise recommendations are saved.</p>
              </div>
            </section>
            :
            <section className="sticky top-0 z-30 mb-5 rounded-card border border-[var(--border)] bg-white px-5 py-3 shadow-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-label font-semibold text-[var(--text)] truncate">{course?.title??'Practice Quiz'}</h2>
                <p className="text-label text-[var(--muted)] shrink-0"><span className="font-semibold text-[var(--text)]">{answered}</span> of {quiz.total} answered</p>
              </div>
              <div className="h-1.5 rounded-full bg-[var(--surface)] border border-[var(--border)] overflow-hidden mt-2.5">
                <div className="h-full bg-[var(--accent)] transition-all" style={{width:answeredPercent+'%'}}/>
              </div>
            </section>}
          {isFinished&&<section className="rounded-card border border-[var(--border)] bg-white p-6 mb-5">
            <h2 className="text-h3 font-semibold text-[var(--text)] mb-4">What to Revise</h2>
            <div className="space-y-2">{quiz.breakdown.map(b=><div key={b.lectureId} className="rounded-card border border-[var(--border)] bg-[var(--surface)] px-4 py-3 flex flex-wrap items-center gap-3">
              {/* No coloured dot: amber is our citation colour, and a second
                  status marker said nothing the score beside it does not. */}
              <p className="flex-1 min-w-0 text-label font-medium text-[var(--text)] truncate">{b.lectureTitle}</p>
              <span className="text-label text-[var(--muted)] shrink-0">{b.correct} of {b.total} correct</span>
              {b.incorrect>0&&<Link className="text-label font-semibold text-[var(--accent)] hover:underline shrink-0" href={'/lecture/'+b.lectureId}>Review</Link>}
            </div>)}</div>
          </section>}
          <div className="space-y-4">
            {quiz.questions.map((q,index)=>{
              const chosen=isFinished?q.selectedIndex:answers[q.id];
              // No edge bar: the wrong option is already tinted red and labelled
              // "Your answer", so the card does not need a second marker saying
              // the same thing.
              const cardEdge='';
              return <section key={q.id} className={'rounded-card border border-[var(--border)] bg-white p-6 '+cardEdge}>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <span className="inline-flex items-center gap-2.5">
                    <span className="w-6 h-6 rounded-full bg-[var(--accent)] text-white text-[11px] font-semibold flex items-center justify-center">{index+1}</span>
                    <span className="text-caption font-semibold text-[var(--muted)]">of {quiz.total}</span>
                  </span>
                  <span className="inline-flex items-center gap-2 min-w-0">
                    <span className="text-caption text-[var(--muted)] truncate max-w-[360px]">{q.lectureTitle}</span>
                    <span className="text-caption text-[var(--muted2)] shrink-0">· {friendlyCategory(q.category)}</span>
                  </span>
                </div>
                <h3 className="text-body font-semibold text-[var(--text)] leading-snug">{q.question}</h3>
                <div className="mt-4 space-y-2">{q.options.map((option,i)=>{
                  const isChosen=chosen===i;
                  const correct=isFinished&&q.correctIndex===i;
                  const wrong=isFinished&&isChosen&&!correct;
                  const style=correct?'border-[var(--accent)] bg-[var(--accent-soft)]':wrong?'border-red-400 bg-red-50':isChosen?'border-[var(--accent)] bg-[var(--accent-soft)]':'border-[var(--border)] hover:bg-[var(--surface)]';
                  const letterStyle=correct||isChosen&&!wrong?'bg-[var(--accent)] border-[var(--accent)] text-white':wrong?'bg-red-700 border-red-700 text-white':'bg-white border-[var(--border)] text-[var(--muted)]';
                  return <label key={i} className={'flex items-center gap-3 rounded-control border px-3 py-2.5 transition-colors '+style+(isFinished?' cursor-default':' cursor-pointer')}>
                    <input type="radio" name={'practice-'+q.id} value={i} disabled={isFinished||pending} checked={isChosen} onChange={()=>setAnswers(prev=>({...prev,[q.id]:i}))} className="sr-only"/>
                    <span className={'w-7 h-7 rounded-full border text-caption font-semibold flex items-center justify-center shrink-0 '+letterStyle}>{LETTERS[i]}</span>
                    <span className="text-label text-[var(--text)] leading-snug">{option}</span>
                    {isFinished&&correct&&<span className="ml-auto text-[var(--accent)] text-caption font-semibold shrink-0">Correct</span>}
                    {isFinished&&wrong&&<span className="ml-auto text-red-700 text-caption font-semibold shrink-0">Your answer</span>}
                  </label>;
                })}</div>
                {isFinished&&<div className="mt-4 rounded-control bg-[var(--surface)] border border-[var(--border)] p-4">
                  <p className={'inline-flex items-center gap-2 text-caption font-semibold '+(q.isCorrect?'text-[var(--accent)]':'text-red-700')}>
                    <i className={'fas '+(q.isCorrect?'fa-circle-check':'fa-circle-exclamation')+' text-[12px]'} />
                    {q.isCorrect?'Answered correctly':'Needs revision'}
                  </p>
                  <p className="text-label text-[var(--text)] mt-2 leading-relaxed">{q.explanation}</p>
                  {/* The stored source label points at the old playlist: slide
                      numbers and transcript times that the re-recorded videos
                      no longer match. The question header already names the
                      lecture, so the stale pointer is simply not shown. */}
                </div>}
              </section>;
            })}
          </div>
          {/* Submit on the left, like every other action button in the app;
              the count sits at the far end of the row. */}
          {!isFinished&&<div className="mt-6 flex flex-wrap items-center gap-3">
            <button disabled={pending||answered!==quiz.total} onClick={submit} className="h-11 rounded-control bg-[var(--accent)] px-8 text-label font-semibold text-white hover:bg-[var(--accent-deep)] active:scale-[0.99] transition disabled:opacity-50 disabled:hover:bg-[var(--accent)]">
              {pending?'Submitting…':'Submit'}
            </button>
            <p className="text-label text-[var(--muted)] ml-auto">{answered} of {quiz.total} answered</p>
          </div>}
          {isFinished&&<div className="mt-6 flex flex-wrap items-center gap-3">
            <button onClick={retake} disabled={pending} className="h-11 rounded-control bg-[var(--accent)] px-8 text-label font-semibold text-white hover:bg-[var(--accent-deep)] active:scale-[0.99] transition disabled:opacity-50">
              {pending?'Preparing…':'Retake Quiz'}
            </button>
            <button onClick={reset} disabled={pending} className="h-11 rounded-control border border-[var(--border)] bg-white px-6 text-label font-semibold text-[var(--text)] hover:bg-[var(--surface)] transition disabled:opacity-50">
              Back to Practice
            </button>
          </div>}
        </div>}
    </main>
  );
}
