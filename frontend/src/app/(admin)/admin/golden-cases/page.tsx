'use client';
import {useState} from 'react';
import {useMutation,useQuery,useLazyQuery} from '@apollo/client';
import {AdminPageHero} from '@/components/admin/AdminPageHero';
import {GET_GOLDEN_CASES,GENERATE_GOLDEN_DRAFTS,REVIEW_GOLDEN_CASE,CREATE_GOLDEN_CASE,GET_GOLDEN_GOLD_JSON} from '@/graphql/golden-case.queries';

type GoldenCase={id:number;caseKey:string;lectureId:number;datasetVersionId:number;question:string;category:string;answerable:boolean;reviewStatus:string;generationMethod:string;expectedChunkIds:number[];reviewedBy:string|null;createdAt:string};
type Draft={question:string;category:string;answerable:boolean;evidence:string};
const STATUSES=['DRAFT','APPROVED','REJECTED','NEEDS_EVIDENCE'];
const CATEGORIES=['factual','conceptual','comparison','compound','follow_up','unsupported','ambiguous','keyword','paraphrase'];
const badge=(s:string)=>s==='APPROVED'?'text-[var(--accent)]':s==='REJECTED'?'text-red-700':'text-[var(--muted)]';
const input='mt-1 w-full rounded-control border border-[var(--border)] bg-[var(--card)] px-3 py-2.5 text-label text-[var(--text)]';
// "101, 102 103" → [101,102,103]; null when any token is not a positive integer.
const parseIds=(s:string):number[]|null=>{const t=s.split(/[\s,]+/).filter(Boolean),n=t.map(Number);return n.every(x=>Number.isSafeInteger(x)&&x>0)?[...new Set(n)]:null;};
const EMPTY:Draft={question:'',category:'unsupported',answerable:false,evidence:''};

function CaseFields({value,onChange}:{value:Draft;onChange:(d:Draft)=>void}){
 return <div className="grid gap-3 md:grid-cols-[1fr_180px_140px]">
  <label className="block text-label font-semibold text-[var(--text)] md:col-span-3">Question
   <textarea className={input} rows={2} value={value.question} onChange={e=>onChange({...value,question:e.target.value})}/>
  </label>
  <label className="block text-label font-semibold text-[var(--text)]">Expected evidence chunk IDs
   <input className={input} disabled={!value.answerable} value={value.answerable?value.evidence:''} onChange={e=>onChange({...value,evidence:e.target.value})} placeholder={value.answerable?'e.g. 101, 102':'none (unsupported)'}/>
  </label>
  <label className="block text-label font-semibold text-[var(--text)]">Category
   <select className={input} value={value.category} onChange={e=>{const category=e.target.value;onChange({...value,category,answerable:category==='unsupported'?false:value.answerable});}}>
    {CATEGORIES.map(c=><option key={c} value={c}>{c}</option>)}
   </select>
  </label>
  <label className="flex items-center gap-2 text-label font-semibold text-[var(--text)] md:mt-7">
   <input type="checkbox" checked={value.answerable} onChange={e=>onChange({...value,answerable:e.target.checked,category:e.target.checked&&value.category==='unsupported'?'factual':value.category})}/>Answerable
  </label>
 </div>;
}

export default function GoldenCasesPage(){
 const [lectureId,setLectureId]=useState('');
 const [versionId,setVersionId]=useState('');
 const [status,setStatus]=useState('');
 const [error,setError]=useState(''),[success,setSuccess]=useState('');
 const [draft,setDraft]=useState<Draft>(EMPTY);
 const [editing,setEditing]=useState<{id:number;value:Draft}|null>(null);
 const vId=Number(versionId);
 const versionOk=Number.isInteger(vId)&&vId>0;

 const list=useQuery(GET_GOLDEN_CASES,{
  variables:{datasetVersionId:vId,status:status||undefined},
  skip:!versionOk,
  fetchPolicy:'cache-and-network',
 });
 const [generate,gen]=useMutation(GENERATE_GOLDEN_DRAFTS);
 const [review,reviewState]=useMutation(REVIEW_GOLDEN_CASE);
 const [create,createState]=useMutation(CREATE_GOLDEN_CASE);
 const [loadGold,goldState]=useLazyQuery(GET_GOLDEN_GOLD_JSON,{fetchPolicy:'network-only'});
 const rows:GoldenCase[]=list.data?.goldenBenchmarkCases??[];

 function ids(){
  const l=Number(lectureId),v=Number(versionId);
  if(!Number.isInteger(l)||l<1||!Number.isInteger(v)||v<1){setError('Enter a valid lecture ID and dataset version ID.');return null;}
  return {l,v};
 }

 async function onGenerate(){
  setError('');setSuccess('');
  const p=ids();if(!p)return;
  try{
   const r=await generate({variables:{lectureId:p.l,datasetVersionId:p.v}});
   const s=r.data?.generateGoldenDraftCases;
   setSuccess(`Drafted ${s?.created??0} new case(s); ${s?.skipped??0} already existed (of ${s?.candidateChunks??0} Q&A chunks).`);
   await list.refetch();
  }catch(e){setError(e instanceof Error?e.message:'Draft generation failed.');}
 }

 async function onCreate(){
  setError('');setSuccess('');
  const p=ids();if(!p)return;
  const evidence=draft.answerable?parseIds(draft.evidence):[];
  if(evidence===null){setError('Evidence must be chunk IDs separated by commas or spaces.');return;}
  try{
   const r=await create({variables:{lectureId:p.l,datasetVersionId:p.v,question:draft.question.trim(),category:draft.category,answerable:draft.answerable,expectedChunkIds:evidence}});
   setSuccess(`Added ${r.data?.createGoldenCase?.caseKey??'case'} as DRAFT — approve it below to include it in the export.`);
   setDraft(EMPTY);await list.refetch();
  }catch(e){setError(e instanceof Error?e.message:'Could not add the case.');}
 }

 async function onReview(id:number,next:string,edit?:Draft){
  setError('');setSuccess('');
  let fields={};
  if(edit){
   const evidence=edit.answerable?parseIds(edit.evidence):[];
   if(evidence===null){setError('Evidence must be chunk IDs separated by commas or spaces.');return;}
   fields={question:edit.question.trim(),category:edit.category,answerable:edit.answerable,expectedChunkIds:evidence};
  }
  try{await review({variables:{id,status:next,...fields}});if(edit)setEditing(null);await list.refetch();}
  catch(e){setError(e instanceof Error?e.message:'Review update failed.');}
 }

 const goldJson:string|undefined=goldState.data?.goldenGoldJson;
 let goldCount=0;try{goldCount=goldJson?(JSON.parse(goldJson).cases?.length??0):0;}catch{goldCount=0;}
 // Readiness for the RAG Evaluation import (it needs 10–2000 cases incl. both kinds).
 const approved=status===''?rows.filter(c=>c.reviewStatus==='APPROVED'):[];
 const approvedAnswerable=approved.filter(c=>c.answerable).length,approvedUnsupported=approved.length-approvedAnswerable;

 return <div className="max-w-[1180px]">
  <AdminPageHero title="Golden Cases" subtitle="Draft benchmark questions from a dataset version, review them, and export the approved gold set."/>

  <section className="rounded-card bg-[var(--card)] border border-[var(--border)] p-5 mb-5">
   <h2 className="text-h3 font-semibold text-[var(--text)]">Draft &amp; review</h2>
   <p className="text-caption text-[var(--muted)] mt-2 mb-4">Drafts are created automatically when a lecture&apos;s dataset version goes live, grounded only in that version&apos;s own Q&amp;A chunks (evidence comes from the source chunks, not retrieval). You can also draft a version by hand. Approved cases export as benchmark truth — this is an explicit human decision.</p>
   {error&&<p role="alert" className="text-label text-red-700 mb-3">{error}</p>}
   {success&&<p role="status" className="text-label text-[var(--accent)] mb-3">{success}</p>}
   <div className="flex flex-wrap items-end gap-3">
    <label className="block text-label font-semibold text-[var(--text)]">Lecture ID
     <input inputMode="numeric" className="mt-1 w-32 rounded-control border border-[var(--border)] bg-[var(--card)] px-3 py-2.5 text-label text-[var(--text)]" value={lectureId} onChange={e=>setLectureId(e.target.value)} placeholder="2"/>
    </label>
    <label className="block text-label font-semibold text-[var(--text)]">Dataset version ID
     <input inputMode="numeric" className="mt-1 w-40 rounded-control border border-[var(--border)] bg-[var(--card)] px-3 py-2.5 text-label text-[var(--text)]" value={versionId} onChange={e=>setVersionId(e.target.value)} placeholder="8"/>
    </label>
    <button type="button" disabled={gen.loading} onClick={()=>void onGenerate()} className="rounded-control bg-[var(--accent)] px-5 py-2.5 text-label font-semibold text-white disabled:opacity-50">Generate drafts</button>
    <button type="button" disabled={!versionOk||goldState.loading} onClick={()=>void loadGold({variables:{datasetVersionId:vId}})} className="rounded-control border border-[var(--border)] px-5 py-2.5 text-label font-semibold text-[var(--text)] disabled:opacity-50">Export approved gold.json</button>
   </div>
   {goldJson!==undefined&&(goldCount===0
    ?<p role="status" className="mt-4 text-label text-[var(--muted)]">No APPROVED cases for this version yet — approve some below before exporting.</p>
    :<label className="block mt-4 text-label font-semibold text-[var(--text)]">Approved gold.json · {goldCount} case(s) (copy into your capture run)
     <textarea readOnly className="mt-1 w-full rounded-control border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-caption text-[var(--text)] font-mono" rows={6} value={goldJson}/>
    </label>)}
  </section>

  <section className="rounded-card bg-[var(--card)] border border-[var(--border)] p-5 mb-5" aria-label="Add a case">
   <h2 className="text-h3 font-semibold text-[var(--text)]">Add a case by hand</h2>
   <p className="text-caption text-[var(--muted)] mt-2 mb-4">Drafts are always answerable. Add questions the lecture <em>cannot</em> answer (category <strong>unsupported</strong>, no evidence) and paraphrased or compound questions here — the RAG Evaluation import needs both answerable and unsupported cases. Evidence IDs must be chunks of the version above.</p>
   <CaseFields value={draft} onChange={setDraft}/>
   <button type="button" disabled={createState.loading||!versionOk||draft.question.trim().length<5} onClick={()=>void onCreate()} className="mt-3 rounded-control bg-[var(--accent)] px-5 py-2.5 text-label font-semibold text-white disabled:opacity-50">Add case</button>
  </section>

  <section className="space-y-3" aria-label="Golden cases">
   <div className="flex flex-wrap items-center justify-between gap-3">
    <h2 className="text-h3 font-semibold text-[var(--text)]">Cases{versionOk?` · version ${vId}`:''}</h2>
    <label className="text-label text-[var(--text)]">Filter
     <select className="ml-2 rounded-control border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-label text-[var(--text)]" value={status} onChange={e=>setStatus(e.target.value)}>
      <option value="">All</option>
      {STATUSES.map(s=><option key={s} value={s}>{s}</option>)}
     </select>
    </label>
   </div>
   {versionOk&&status===''&&rows.length>0&&<p className="text-caption text-[var(--muted)]">Approved: {approvedAnswerable} answerable · {approvedUnsupported} unsupported.{approved.length<10||approvedAnswerable===0||approvedUnsupported===0?' The RAG Evaluation import needs at least 10 approved cases including both kinds.':' Ready for capture and import.'}</p>}
   {!versionOk&&<div className="rounded-card bg-[var(--card)] border border-[var(--border)] p-6"><p className="text-label text-[var(--muted)]">Enter a dataset version ID above to list its cases.</p></div>}
   {list.loading&&!list.data&&<p role="status" className="text-label text-[var(--muted)]">Loading cases…</p>}
   {list.error&&<p role="alert" className="text-label text-[var(--text)]">Could not load cases. <button type="button" className="underline" onClick={()=>void list.refetch()}>Retry</button></p>}
   {!list.loading&&!list.error&&versionOk&&!rows.length&&<div className="rounded-card bg-[var(--card)] border border-[var(--border)] p-6"><p className="text-label text-[var(--muted)]">No cases{status?` with status ${status}`:''}. Generate drafts or add a case to begin.</p></div>}
   {rows.map(c=><article key={c.id} className="rounded-card bg-[var(--card)] border border-[var(--border)] p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
     <div className="min-w-0">
      <p className="text-caption text-[var(--muted)]"><span className={`font-semibold ${badge(c.reviewStatus)}`}>{c.reviewStatus}</span> · {c.caseKey} · {c.category}{c.answerable?'':' · unsupported'}{c.generationMethod==='MANUAL'?' · manual':''} · evidence [{c.expectedChunkIds.join(', ')||'none'}]</p>
      <p className="text-label text-[var(--text)] mt-1 break-words">{c.question}</p>
     </div>
     <div className="flex flex-wrap gap-2 shrink-0">
      <button type="button" disabled={reviewState.loading} onClick={()=>void onReview(c.id,'APPROVED')} className="rounded-control bg-[var(--accent)] px-3 py-1.5 text-caption font-semibold text-white disabled:opacity-50">Approve</button>
      <button type="button" disabled={reviewState.loading} onClick={()=>void onReview(c.id,'NEEDS_EVIDENCE')} className="rounded-control border border-[var(--border)] px-3 py-1.5 text-caption font-semibold text-[var(--text)] disabled:opacity-50">Needs evidence</button>
      <button type="button" disabled={reviewState.loading} onClick={()=>void onReview(c.id,'REJECTED')} className="rounded-control border border-[var(--border)] px-3 py-1.5 text-caption font-semibold text-red-700 disabled:opacity-50">Reject</button>
      <button type="button" onClick={()=>setEditing(editing?.id===c.id?null:{id:c.id,value:{question:c.question,category:c.category,answerable:c.answerable,evidence:c.expectedChunkIds.join(', ')}})} className="rounded-control border border-[var(--border)] px-3 py-1.5 text-caption font-semibold text-[var(--text)]">{editing?.id===c.id?'Cancel':'Edit'}</button>
     </div>
    </div>
    {editing?.id===c.id&&<div className="mt-4 border-t border-[var(--border)] pt-4">
     <CaseFields value={editing.value} onChange={value=>setEditing({id:c.id,value})}/>
     <button type="button" disabled={reviewState.loading||editing.value.question.trim().length<5} onClick={()=>void onReview(c.id,c.reviewStatus,editing.value)} className="mt-3 rounded-control bg-[var(--accent)] px-5 py-2.5 text-label font-semibold text-white disabled:opacity-50">Save changes ({c.reviewStatus})</button>
    </div>}
   </article>)}
  </section>

  <p className="mt-6 text-caption text-[var(--muted)]">Deterministic drafts use each chunk&apos;s own question as the benchmark question and its own chunk as evidence — a baseline, not proof of answer quality. Use Edit to paraphrase and categorise, and add unsupported cases above for a rigorous set.</p>
 </div>;
}
