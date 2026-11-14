'use client';
import { useState } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import {
 GET_COURSE_MISCONCEPTIONS,GET_MISCONCEPTION_REVIEW,CREATE_MISCONCEPTION,SET_DISTRACTOR_MISCONCEPTION
} from '@/graphql/misconception.queries';

type Outcome={id:number;code:string;description:string};
type Misconception={id:number;outcomeId:number;code:string;description:string};
type Question={questionId:number;question:string;options:string[];correctIndex:number;outcomeId:number|null;mappings:{optionIndex:number;misconceptionId:number}[]};
const field='w-full rounded-control border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-label text-[var(--text)] focus:border-[var(--accent)] outline-none';
export function MisconceptionReview({courseId,outcomes}:{courseId:number;outcomes:Outcome[]}){
 const taxonomy=useQuery(GET_COURSE_MISCONCEPTIONS,{variables:{courseId},fetchPolicy:'cache-and-network'});
 const items=useQuery(GET_MISCONCEPTION_REVIEW,{variables:{courseId,limit:50},fetchPolicy:'cache-and-network'});
 const [create]=useMutation(CREATE_MISCONCEPTION);
 const [tag]=useMutation(SET_DISTRACTOR_MISCONCEPTION);
 const [outcomeId,setOutcomeId]=useState<number|null>(null);
 const [code,setCode]=useState('');
 const [description,setDescription]=useState('');
 const [error,setError]=useState('');
 const [success,setSuccess]=useState('');
 const [busy,setBusy]=useState(false);
 const groups:Misconception[]=taxonomy.data?.courseMisconceptions??[];
 const questions:Question[]=items.data?.misconceptionQuestionReview??[];
 const current=outcomeId!==null&&outcomes.some(x=>x.id===outcomeId)?outcomeId:(outcomes[0]?.id??null);
 async function run(action:()=>Promise<unknown>,label:string){
  if(busy)return;setBusy(true);setError('');setSuccess('');
  try{await action();await Promise.all([items.refetch(),taxonomy.refetch()]);setSuccess(label);}
  catch(e){setError(e instanceof Error?e.message:'Unable to save misconception mapping.');}
  finally{setBusy(false);}
 }
 const submit=async(e:React.FormEvent)=>{
  e.preventDefault();if(current===null)return;
  await run(async()=>{
   await create({variables:{courseId,outcomeId:current,code:code.trim(),description:description.trim()}});
   setCode('');setDescription('');
  },'Misconception definition saved.');
 };
 return <section className="learning-form-a11y rounded-card border border-[var(--border)] bg-[var(--card)] px-5 py-6 mt-5">
  <h2 className="text-h3 font-semibold text-[var(--text)]">Misconception review</h2>
  <p className="text-caption text-[var(--muted)] mt-1 mb-5">Define a specific misunderstanding and approve which wrong MCQ option shows it. Wrong answers alone never prove a misconception.</p>
  {busy&&<p role="status" className="sr-only">Saving admin review…</p>}
  {error&&<div role="alert" className="text-label text-red-700 mb-3">{error}</div>}
  {success&&<div role="status" className="text-label text-[var(--accent)] mb-3">{success}</div>}
  <form onSubmit={e=>void submit(e)} className="grid gap-3 sm:grid-cols-2 mb-6">
   <label className="text-label text-[var(--text)]">Course learning outcome
    <select value={current??''} onChange={e=>setOutcomeId(Number(e.target.value))} className={field+' mt-1'} disabled={busy||!outcomes.length}>
     {outcomes.map(o=><option key={o.id} value={o.id}>{o.code} — {o.description.slice(0,65)}</option>)}
    </select>
   </label>
   <label className="text-label text-[var(--text)]">Misconception code
    <input className={field+' mt-1'} required maxLength={40} value={code} onChange={e=>setCode(e.target.value)} placeholder="CONFUSION_1"/>
   </label>
   <label className="sm:col-span-2 text-label text-[var(--text)]">Description of the misunderstanding
    <textarea className={field+' mt-1'} required minLength={8} maxLength={600} value={description} onChange={e=>setDescription(e.target.value)} rows={2} placeholder="Confuses precision with recall."/>
   </label>
   <div className="sm:col-span-2"><button type="submit" disabled={busy||!outcomes.length} className="rounded-control px-5 py-2.5 bg-[var(--accent)] text-white font-semibold text-label hover:bg-[var(--accent-deep)] disabled:opacity-50">Add admin-approved misconception</button></div>
  </form>
  {taxonomy.error&&<p role="alert" className="text-label text-red-700">Could not load misconception definitions.</p>}
  <div className="mb-5 space-y-2">
   {groups.map(m=><p key={m.id} className="rounded-control bg-[var(--surface)] px-3 py-2 text-label text-[var(--text)]"><strong>{m.code}</strong> · {m.description}</p>)}
  </div>
  <h3 className="text-label font-semibold text-[var(--text)] mb-2">Review recent quiz options</h3>
  <p className="text-caption text-[var(--muted)] mb-3">Only questions already mapped to a CLO can be tagged. Correct choices cannot be selected.</p>
  {items.loading&&!questions.length&&<p role="status" className="text-label text-[var(--muted)]">Loading questions…</p>}
  {items.error&&<p role="alert" className="text-label text-red-700">Could not load questions. Check development migration 034.</p>}
  {!items.loading&&!questions.length&&<p className="text-label text-[var(--muted)]">No quiz questions available yet.</p>}
  <div className="space-y-5">
  {questions.filter(q=>q.outcomeId!==null).map(q=><article key={q.questionId} className="border-t border-[var(--border)] pt-4">
    <p className="font-semibold text-label text-[var(--text)]">{q.question}</p>
    <p className="text-caption text-[var(--muted)] mt-1 mb-3">Question #{q.questionId} · Correct answer is shown only in this admin review.</p>
    {q.options.map((option,index)=>{
     const selected=q.mappings.find(m=>m.optionIndex===index)?.misconceptionId;
     const eligible=groups.filter(m=>m.outcomeId===q.outcomeId);
     return <div key={index} className="grid md:grid-cols-[1fr_230px] gap-3 items-center mb-2">
      <span className="text-label text-[var(--text)]">{String.fromCharCode(65+index)}. {option} {index===q.correctIndex&&<strong className="text-[var(--accent)]">(Correct)</strong>}</span>
      {index===q.correctIndex?<span className="text-caption text-[var(--muted)]">Not eligible for a misconception tag</span>:
      <select aria-label={'Misconception for option '+String.fromCharCode(65+index)+' of question '+q.questionId}
       value={selected??''} disabled={busy||!eligible.length} className={field}
       onChange={e=>void run(()=>tag({variables:{courseId,questionId:q.questionId,optionIndex:index,misconceptionId:e.target.value?Number(e.target.value):null}}),'Option mapping updated.')}>
       <option value="">No approved misconception</option>
       {eligible.map(m=><option key={m.id} value={m.id}>{m.code}</option>)}
      </select>}
     </div>;
    })}
   </article>)}
  </div>
 </section>;
}
