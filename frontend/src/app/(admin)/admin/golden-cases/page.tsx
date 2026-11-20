'use client';
import {useState} from 'react';
import {useMutation,useQuery,useLazyQuery} from '@apollo/client';
import {AdminPageHero} from '@/components/admin/AdminPageHero';
import {GET_GOLDEN_CASES,GENERATE_GOLDEN_DRAFTS,REVIEW_GOLDEN_CASE,GET_GOLDEN_GOLD_JSON} from '@/graphql/golden-case.queries';

type GoldenCase={id:number;caseKey:string;lectureId:number;datasetVersionId:number;question:string;category:string;answerable:boolean;reviewStatus:string;expectedChunkIds:number[];reviewedBy:string|null;createdAt:string};
const STATUSES=['DRAFT','APPROVED','REJECTED','NEEDS_EVIDENCE'];
const badge=(s:string)=>s==='APPROVED'?'text-[var(--accent)]':s==='REJECTED'?'text-red-700':'text-[var(--muted)]';

export default function GoldenCasesPage(){
 const [lectureId,setLectureId]=useState('');
 const [versionId,setVersionId]=useState('');
 const [status,setStatus]=useState('');
 const [error,setError]=useState(''),[success,setSuccess]=useState('');
 const vId=Number(versionId);

 const list=useQuery(GET_GOLDEN_CASES,{
  variables:{datasetVersionId:vId,status:status||undefined},
  skip:!Number.isInteger(vId)||vId<1,
  fetchPolicy:'cache-and-network',
 });
 const [generate,gen]=useMutation(GENERATE_GOLDEN_DRAFTS);
 const [review]=useMutation(REVIEW_GOLDEN_CASE);
 const [loadGold,goldState]=useLazyQuery(GET_GOLDEN_GOLD_JSON,{fetchPolicy:'network-only'});
 const rows:GoldenCase[]=list.data?.goldenBenchmarkCases??[];

 async function onGenerate(){
  setError('');setSuccess('');
  const l=Number(lectureId),v=Number(versionId);
  if(!Number.isInteger(l)||l<1||!Number.isInteger(v)||v<1){setError('Enter a valid lecture ID and dataset version ID.');return;}
  try{
   const r=await generate({variables:{lectureId:l,datasetVersionId:v}});
   const s=r.data?.generateGoldenDraftCases;
   setSuccess(`Drafted ${s?.created??0} new case(s); ${s?.skipped??0} already existed (of ${s?.candidateChunks??0} Q&A chunks).`);
   await list.refetch();
  }catch(e){setError(e instanceof Error?e.message:'Draft generation failed.');}
 }

 async function onReview(id:number,next:string){
  setError('');setSuccess('');
  try{await review({variables:{id,status:next}});await list.refetch();}
  catch(e){setError(e instanceof Error?e.message:'Review update failed.');}
 }

 const goldJson:string|undefined=goldState.data?.goldenGoldJson;

 return <div className="max-w-[1180px]">
  <AdminPageHero title="Golden Cases" subtitle="Draft benchmark questions from a dataset version, review them, and export the approved gold set."/>

  <section className="rounded-card bg-[var(--card)] border border-[var(--border)] p-5 mb-5">
   <h2 className="text-h3 font-semibold text-[var(--text)]">Draft &amp; review</h2>
   <p className="text-caption text-[var(--muted)] mt-2 mb-4">Drafts are grounded only in the pinned dataset version&apos;s own Q&amp;A chunks; evidence comes from the source chunks, not retrieval. Approved cases export as benchmark truth — this is an explicit human decision.</p>
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
    <button type="button" disabled={!Number.isInteger(vId)||vId<1||goldState.loading} onClick={()=>void loadGold({variables:{datasetVersionId:vId}})} className="rounded-control border border-[var(--border)] px-5 py-2.5 text-label font-semibold text-[var(--text)] disabled:opacity-50">Export approved gold.json</button>
   </div>
   {goldJson!==undefined&&<label className="block mt-4 text-label font-semibold text-[var(--text)]">Approved gold.json (copy into your capture run)
    <textarea readOnly className="mt-1 w-full rounded-control border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-caption text-[var(--text)] font-mono" rows={6} value={goldJson}/>
   </label>}
  </section>

  <section className="space-y-3" aria-label="Golden cases">
   <div className="flex flex-wrap items-center justify-between gap-3">
    <h2 className="text-h3 font-semibold text-[var(--text)]">Cases{Number.isInteger(vId)&&vId>0?` · version ${vId}`:''}</h2>
    <label className="text-label text-[var(--text)]">Filter
     <select className="ml-2 rounded-control border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-label text-[var(--text)]" value={status} onChange={e=>setStatus(e.target.value)}>
      <option value="">All</option>
      {STATUSES.map(s=><option key={s} value={s}>{s}</option>)}
     </select>
    </label>
   </div>
   {(!Number.isInteger(vId)||vId<1)&&<div className="rounded-card bg-[var(--card)] border border-[var(--border)] p-6"><p className="text-label text-[var(--muted)]">Enter a dataset version ID above to list its cases.</p></div>}
   {list.loading&&!list.data&&<p role="status" className="text-label text-[var(--muted)]">Loading cases…</p>}
   {list.error&&<p role="alert" className="text-label text-[var(--text)]">Could not load cases. <button type="button" className="underline" onClick={()=>void list.refetch()}>Retry</button></p>}
   {!list.loading&&!list.error&&Number.isInteger(vId)&&vId>0&&!rows.length&&<div className="rounded-card bg-[var(--card)] border border-[var(--border)] p-6"><p className="text-label text-[var(--muted)]">No cases{status?` with status ${status}`:''}. Generate drafts to begin.</p></div>}
   {rows.map(c=><article key={c.id} className="rounded-card bg-[var(--card)] border border-[var(--border)] p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
     <div className="min-w-0">
      <p className="text-caption text-[var(--muted)]"><span className={`font-semibold ${badge(c.reviewStatus)}`}>{c.reviewStatus}</span> · {c.caseKey} · {c.category} · evidence [{c.expectedChunkIds.join(', ')||'none'}]</p>
      <p className="text-label text-[var(--text)] mt-1 break-words">{c.question}</p>
     </div>
     <div className="flex gap-2 shrink-0">
      <button type="button" onClick={()=>void onReview(c.id,'APPROVED')} className="rounded-control bg-[var(--accent)] px-3 py-1.5 text-caption font-semibold text-white">Approve</button>
      <button type="button" onClick={()=>void onReview(c.id,'NEEDS_EVIDENCE')} className="rounded-control border border-[var(--border)] px-3 py-1.5 text-caption font-semibold text-[var(--text)]">Needs evidence</button>
      <button type="button" onClick={()=>void onReview(c.id,'REJECTED')} className="rounded-control border border-[var(--border)] px-3 py-1.5 text-caption font-semibold text-red-700">Reject</button>
     </div>
    </div>
   </article>)}
  </section>

  <p className="mt-6 text-caption text-[var(--muted)]">Deterministic drafts use each chunk&apos;s own question as the benchmark question and its own chunk as evidence — a baseline, not proof of answer quality. Paraphrase, categorise and add unsupported cases during review for a rigorous set.</p>
 </div>;
}
