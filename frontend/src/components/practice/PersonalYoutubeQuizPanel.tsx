'use client';
import {useCallback,useEffect,useState} from 'react';
import Link from 'next/link';
import api from '@/lib/api';

type Video={video_id:string;title:string;position:number;ingest_status:string};
type Course={id:string;title:string;channel_title:string;status:string;videos:Video[]};
type Question={id:number;videoId:string;lectureTitle:string;category:string;question:string;options:string[];selectedIndex:number|null;correctIndex:number|null;isCorrect:boolean|null;explanation:string|null;source:string|null};
type Quiz={id:number;courseId:number;videoIds:string[];status:string;total:number;correct:number|null;percent:number|null;questions:Question[];createdAt:string};
type History={id:number;courseId:number;status:string;total:number;percent:number|null;createdAt:string};
const LETTERS=['A','B','C','D'];
const path='/youtube/my-quizzes';

export default function PersonalYoutubeQuizPanel(){
  const [courses,setCourses]=useState<Course[]>([]);
  const [history,setHistory]=useState<History[]>([]);
  const [courseId,setCourseId]=useState<string>('');
  const [selected,setSelected]=useState<string[]>([]);
  const [quiz,setQuiz]=useState<Quiz|null>(null);
  const [answers,setAnswers]=useState<Record<number,number>>({});
  const [loading,setLoading]=useState(true);
  const [pending,setPending]=useState(false);
  const [error,setError]=useState('');
  const load=useCallback(async()=>{
    try{
      const [a,b]=await Promise.all([api.get('/youtube/my-courses'),api.get(path)]);
      setCourses(a.data.data.courses??[]);
      setHistory(b.data.data.quizzes??[]);
    }catch{setError('Your private YouTube courses could not be loaded.');}
    finally{setLoading(false);}
  },[]);
  useEffect(()=>{void load();},[load]);
  const readyCourses=courses.filter(c=>c.videos.some(v=>v.ingest_status==='READY')&&['READY','PARTIAL'].includes(c.status));
  const course=readyCourses.find(c=>c.id===courseId);
  const videos=course?.videos.filter(v=>v.ingest_status==='READY')??[];
  const toggle=(videoId:string)=>setSelected(s=>s.includes(videoId)?s.filter(x=>x!==videoId):[...s,videoId]);
  const generate=async()=>{
    if(!course||!selected.length||pending)return;
    setPending(true);setError('');
    try{
      const res=await api.post(path,{courseId:Number(course.id),videoIds:selected});
      const created=res.data.data.quiz as Quiz;
      if(!created?.questions?.length)throw new Error('No questions were generated.');
      setQuiz(created);setAnswers({});await load();
    }catch(e:any){setError(e?.response?.data?.message??'Quiz generation failed. Please try again.');}
    finally{setPending(false);}
  };
  const open=async(id:number)=>{
    setPending(true);setError('');
    try{const r=await api.get(path+'/'+id);setQuiz(r.data.data.quiz);setAnswers({});}
    catch{setError('Unable to open that quiz.');}
    finally{setPending(false);}
  };
  const submit=async()=>{
    if(!quiz||pending||quiz.status==='COMPLETED')return;
    if(quiz.questions.some(q=>answers[q.id]===undefined)){setError('Please answer every question first.');return;}
    setPending(true);setError('');
    try{
      const r=await api.post(path+'/'+quiz.id+'/submit',{answers:quiz.questions.map(q=>({questionId:q.id,selectedIndex:answers[q.id]}))});
      setQuiz(r.data.data.quiz);await load();window.scrollTo({top:0,behavior:'smooth'});
    }catch(e:any){setError(e?.response?.data?.message??'Could not submit your quiz.');}
    finally{setPending(false);}
  };
  const finished=quiz?.status==='COMPLETED';
  return <section aria-label="My YouTube practice quizzes" className="mt-6">
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-h2 font-semibold text-[var(--text)]">My YouTube Courses</h2>
        <p className="text-label text-[var(--muted)] mt-1">Private courses you added. Generate quizzes only from your selected ready lectures.</p>
      </div>
      <Link href="/courses" className="text-label font-semibold text-[var(--accent)] hover:underline">Manage courses <i className="fas fa-arrow-right ml-1 text-[11px]"/></Link>
    </div>
    {error&&<p role="alert" className="mb-4 rounded-card border border-red-200 bg-red-50 p-3 text-label text-red-700">{error}</p>}
    {loading?<div className="rounded-card border border-[var(--border)] bg-white p-8 text-label text-[var(--muted)]">Loading your courses…</div>:
     !quiz?<div className="grid gap-5 lg:grid-cols-[1fr_320px] items-start">
       <div className="rounded-card border border-[var(--border)] bg-white p-6">
         <div className="flex items-center justify-between gap-3 mb-4">
           <h3 className="text-h3 font-semibold">Select Lectures</h3>
           <span className="text-caption rounded-full bg-[var(--accent-soft)] text-[var(--accent-deep)] px-3 py-1">Private to you</span>
         </div>
         {readyCourses.length===0?<p className="text-label text-[var(--muted)] p-5 bg-[var(--surface)] rounded-control">No indexed personal lectures yet. <Link className="underline text-[var(--accent)]" href="/courses">Add a YouTube course</Link> and import its captions first.</p>:<>
           <label htmlFor="personal-practice-course" className="block text-label text-[var(--muted)] font-medium mb-2">Course</label>
           <select id="personal-practice-course" value={courseId} disabled={pending}
             onChange={e=>{setCourseId(e.target.value);setSelected([]);setError('');}}
             className="w-full h-11 rounded-control border border-[var(--border)] bg-white px-3 text-body mb-5">
             <option value="">Choose your YouTube course</option>
             {readyCourses.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}
           </select>
           {course&&<div className="space-y-2">
             <div className="flex items-center justify-between mb-3">
               <p className="text-label font-semibold">{videos.length} lecture{videos.length===1?'':'s'} ready</p>
               <button disabled={pending} type="button" onClick={()=>setSelected(selected.length===videos.length?[]:videos.map(v=>v.video_id))}
                 className="text-label font-semibold text-[var(--accent)] hover:underline">{selected.length===videos.length?'Clear all':'Select all'}</button>
             </div>
             {videos.map(v=><label key={v.video_id} className={'flex items-center gap-3 rounded-card border px-4 py-3 cursor-pointer transition-colors '+(selected.includes(v.video_id)?'border-[var(--accent)] bg-[var(--accent-soft)]':'border-[var(--border)] hover:bg-[var(--surface)]')}>
               <input type="checkbox" className="sr-only" checked={selected.includes(v.video_id)} disabled={pending} onChange={()=>toggle(v.video_id)}/>
               <span className={'w-5 h-5 rounded-[5px] border flex items-center justify-center shrink-0 '+(selected.includes(v.video_id)?'bg-[var(--accent)] text-white':'bg-white border-[var(--border)]')}>
                 {selected.includes(v.video_id)&&<i className="fas fa-check text-[10px]"/>}
               </span>
               <img alt="" src={'https://i.ytimg.com/vi/'+v.video_id+'/mqdefault.jpg'} className="w-[80px] aspect-video rounded-control object-cover bg-[var(--surface)]"/>
               <span className="min-w-0 flex-1 text-label font-medium">{v.position}. {v.title}</span>
               <span className="text-caption text-[var(--muted)] shrink-0">Ready</span>
             </label>)}
           </div>}
         </>}
       </div>
       <aside className="rounded-card border border-[var(--border)] bg-white p-6 h-fit lg:sticky lg:top-6">
         <h3 className="text-h3 font-semibold">Start a Quiz</h3>
         <div className="mt-4 flex items-baseline gap-2"><strong className="text-display text-[var(--accent)]">{selected.length}</strong><span className="text-label text-[var(--muted)]">lecture{selected.length===1?'':'s'} selected</span></div>
         <div className="mt-5 rounded-control bg-[var(--surface)] p-4">
           <p className="text-label font-semibold">Up to 10 questions</p>
           <p className="text-caption text-[var(--muted)] mt-1">Grounded in your imported video transcripts. No quiz is generated until you click below.</p>
         </div>
         <button type="button" onClick={()=>void generate()} disabled={pending||!selected.length}
           className="mt-5 h-11 w-full rounded-control bg-[var(--accent)] text-white text-label font-semibold hover:bg-[var(--accent-deep)] disabled:opacity-50">
           {pending?'Preparing your quiz…':'Generate Quiz'}
         </button>
         <p className="mt-3 text-caption text-[var(--muted)]">Only you can access these quiz attempts.</p>
       </aside>
     </div>:
     <div className="max-w-[900px] mx-auto">
       <button type="button" disabled={pending} onClick={()=>{setQuiz(null);setError('');setAnswers({});}} className="text-label font-semibold text-[var(--accent)] mb-5 hover:underline"><i className="fas fa-arrow-left mr-2"/>Back to Practice</button>
       <div className="rounded-card border border-[var(--border)] bg-white p-6 mb-5">
         {finished?<><p className="text-caption text-[var(--accent)] font-semibold">Practice complete</p>
           <h3 className="text-h1 font-semibold mt-1">{quiz.correct} / {quiz.total} correct · {quiz.percent}%</h3>
           <p className="text-label text-[var(--muted)] mt-2">Review your answers, explanations and video references below.</p></>:
           <><h3 className="text-h3 font-semibold">YouTube Practice Quiz</h3><p className="text-label text-[var(--muted)] mt-2">Answer all {quiz.total} questions before submitting.</p></>}
       </div>
       <div className="space-y-4">{quiz.questions.map((q,i)=><div key={q.id} className="rounded-card border border-[var(--border)] bg-white p-6">
         <p className="text-caption text-[var(--muted)] mb-2">Question {i+1} of {quiz.total} · {q.lectureTitle}</p>
         <p className="text-body font-semibold mb-5">{q.question}</p>
         <div className="grid gap-2">{q.options.map((option,index)=>{
           const checked=finished?q.selectedIndex===index:answers[q.id]===index;
           return <label key={index} className={'flex items-start gap-3 rounded-control border p-3 text-label transition-colors '+(checked?'border-[var(--accent)] bg-[var(--accent-soft)]':'border-[var(--border)] hover:bg-[var(--surface)]')}>
             <input type="radio" className="mt-1 accent-[var(--accent)]" name={'personal-q-'+q.id} checked={checked}
               disabled={finished||pending} onChange={()=>setAnswers(prev=>({...prev,[q.id]:index}))}/>
             <strong>{LETTERS[index]}.</strong><span>{option}</span>
           </label>;
         })}</div>
         {finished&&<div className="mt-4 p-4 rounded-control bg-[var(--surface)] text-label">
           <strong className={q.isCorrect?'text-emerald-700':'text-red-700'}>{q.isCorrect?'Correct':'Incorrect'}</strong>
           <p className="mt-2">{q.explanation}</p>
           {q.source&&<p className="mt-2 text-caption text-[var(--gold)]">Source: {q.source}</p>}
         </div>}
       </div>)}</div>
       {!finished&&<button type="button" onClick={()=>void submit()} disabled={pending} className="mt-5 px-6 h-11 bg-[var(--accent)] text-white rounded-control text-label font-semibold disabled:opacity-50">{pending?'Submitting…':'Submit Quiz'}</button>}
     </div>}
    {history.length>0&&!quiz&&<div className="mt-5 rounded-card border border-[var(--border)] bg-white p-6">
      <h3 className="text-h3 font-semibold mb-3">Recent YouTube Quizzes</h3>
      <div className="space-y-2">{history.slice(0,6).map(h=><button key={h.id} disabled={pending} type="button" onClick={()=>void open(h.id)}
        className="w-full rounded-control border border-[var(--border)] px-4 py-3 flex justify-between hover:bg-[var(--surface)] text-left">
        <span className="text-label">Quiz · {new Date(h.createdAt).toLocaleDateString()}</span>
        <span className="text-caption text-[var(--muted)]">{h.status==='COMPLETED'?h.percent+'%':'Not finished'} <i className="fas fa-chevron-right ml-2"/></span>
      </button>)}</div>
    </div>}
  </section>;
}
