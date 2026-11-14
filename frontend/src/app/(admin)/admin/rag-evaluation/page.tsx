'use client';
import {useState} from 'react';
import {useMutation,useQuery} from '@apollo/client';
import {AdminPageHero} from '@/components/admin/AdminPageHero';
import {GET_RAG_BENCHMARK_RUNS,IMPORT_RAG_BENCHMARK} from '@/graphql/rag-benchmark.queries';
type Run={id:number;label:string;caseCount:number;answerable:number;unsupported:number;lectureVersions:string[];metrics:string;createdAt:string};
type MetricSet={retrieval?:Record<string,{recallAt5:number|null;mrr:number|null;ndcgAt5:number|null}>;human?:Record<string,{passRate:number|null;reviewed:number;unreviewed:number}>;citations?:{precision:number|null;recall:number|null};refusal?:{unsupportedCorrectRate:number|null};latency?:{p50Ms:number|null;p95Ms:number|null}};
const pct=(value:number|null|undefined)=>value==null?'Not measured':(value*100).toFixed(1)+'%';
export default function RagEvaluationPage(){
 const list=useQuery(GET_RAG_BENCHMARK_RUNS,{variables:{limit:20},fetchPolicy:'cache-and-network'});
 const [label,setLabel]=useState(''),[gold,setGold]=useState(''),[pred,setPred]=useState('');
 const [error,setError]=useState(''),[success,setSuccess]=useState('');
 const [upload,busy]=useMutation(IMPORT_RAG_BENCHMARK);
 const rows:Run[]=list.data?.ragBenchmarkRuns??[];
 async function submit(e:React.FormEvent){
  e.preventDefault();setError('');setSuccess('');
  try{
   await upload({variables:{label:label.trim(),goldJson:gold,predictionsJson:pred}});
   await list.refetch();
   setGold('');setPred('');setSuccess('Evaluated aggregates saved. Raw question and answer JSON was not stored.');
  }catch(e){setError(e instanceof Error?e.message:'Benchmark import failed.');}
 }
 return <div className="max-w-[1180px]">
  <AdminPageHero title="RAG Evaluation" subtitle="Faculty-reviewed golden labels, measured retrieval evidence and reproducible historical results."/>
  <section className="rounded-card bg-[var(--card)] border border-[var(--border)] p-5 mb-5">
   <h2 className="text-h3 font-semibold text-[var(--text)]">Import a measured benchmark</h2>
   <p className="text-caption text-[var(--muted)] mt-2 mb-4">Provide paired JSON from a real evaluation run using the Golden RAG evaluation contract. Reports are recalculated on the server. Do not upload student names, personal data or private conversations.</p>
   {error&&<p role="alert" className="text-label text-red-700 mb-3">{error}</p>}
   {success&&<p role="status" className="text-label text-[var(--accent)] mb-3">{success}</p>}
   <form onSubmit={e=>void submit(e)} className="space-y-3">
    <label className="block text-label font-semibold text-[var(--text)]">Benchmark label
     <input className="mt-1 w-full rounded-control border border-[var(--border)] bg-[var(--card)] px-3 py-2.5 text-label text-[var(--text)]" required minLength={3} maxLength={100} value={label} onChange={e=>setLabel(e.target.value)} placeholder="English Lecture 1 · November baseline"/>
    </label>
    <label className="block text-label font-semibold text-[var(--text)]">Faculty-reviewed gold.json
     <textarea className="mt-1 w-full rounded-control border border-[var(--border)] bg-[var(--card)] px-3 py-2.5 text-label text-[var(--text)] font-mono" rows={3} required value={gold} onChange={e=>setGold(e.target.value)} placeholder='{"schemaVersion":1,"cases":[...]}'/>
    </label>
    <label className="block text-label font-semibold text-[var(--text)]">Recorded predictions.json
     <textarea className="mt-1 w-full rounded-control border border-[var(--border)] bg-[var(--card)] px-3 py-2.5 text-label text-[var(--text)] font-mono" rows={3} required value={pred} onChange={e=>setPred(e.target.value)} placeholder='{"schemaVersion":1,"cases":[...]}'/>
    </label>
    <button type="submit" disabled={busy.loading} className="rounded-control bg-[var(--accent)] px-5 py-2.5 text-label font-semibold text-white disabled:opacity-50">Validate and save measured result</button>
   </form>
  </section>
  <section className="space-y-4" aria-label="Benchmark history">
   <h2 className="text-h3 font-semibold text-[var(--text)]">Benchmark history</h2>
   {list.loading&&!list.data&&<p role="status" className="text-label text-[var(--muted)]">Loading benchmark history…</p>}
   {list.error&&<p role="alert" className="text-label text-[var(--text)]">Could not load saved benchmarks. <button type="button" className="underline" onClick={()=>void list.refetch()}>Retry</button></p>}
   {!list.loading&&!list.error&&!rows.length&&<div className="rounded-card bg-[var(--card)] border border-[var(--border)] p-6"><p className="text-label text-[var(--muted)]">No measured benchmarks saved yet. Accuracy and educational improvement are not measured.</p></div>}
   {rows.map(run=>{
    let m:MetricSet={};try{m=JSON.parse(run.metrics) as MetricSet;}catch{return <p key={run.id} role="alert">Invalid saved benchmark #{run.id}</p>;}
    return <article key={run.id} className="rounded-card bg-[var(--card)] border border-[var(--border)] p-5">
     <div className="flex flex-wrap justify-between items-start gap-3">
      <div><h3 className="text-h3 font-semibold text-[var(--text)]">{run.label}</h3>
       <p className="text-caption text-[var(--muted)] mt-1">{run.caseCount} reviewed questions · {run.answerable} answerable · {run.unsupported} unsupported</p>
      </div><p className="text-caption text-[var(--muted)]">{new Date(run.createdAt).toLocaleDateString('en-GB')}</p>
     </div>
     <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
      {[{name:'Hybrid Recall@5',value:pct(m.retrieval?.hybrid?.recallAt5)},
        {name:'Rerank nDCG@5',value:pct(m.retrieval?.reranked?.ndcgAt5)},
        {name:'Citation precision',value:pct(m.citations?.precision)},
        {name:'Answer correctness',value:pct(m.human?.answerCorrect?.passRate)},
        {name:'Groundedness',value:pct(m.human?.grounded?.passRate)},
        {name:'Unsupported refusal',value:pct(m.refusal?.unsupportedCorrectRate)},
        {name:'P50 latency',value:m.latency?.p50Ms==null?'Not measured':m.latency.p50Ms+' ms'},
        {name:'P95 latency',value:m.latency?.p95Ms==null?'Not measured':m.latency.p95Ms+' ms'}].map(metric=>
        <div key={metric.name} className="rounded-control bg-[var(--surface)] p-3">
         <p className="text-caption text-[var(--muted)]">{metric.name}</p>
         <p className="text-label font-semibold text-[var(--text)] mt-1">{metric.value}</p>
        </div>)}
     </div>
     <p className="mt-4 text-caption text-[var(--muted)]">Pinned dataset scope: {run.lectureVersions.join(', ')}</p>
     <p className="mt-2 text-caption text-[var(--muted)]">Human answer reviews: {m.human?.answerCorrect?.reviewed??0} / {run.caseCount}. Educational pre/post learning gains: <strong>not measured</strong>.</p>
    </article>;
   })}
  </section>
  <p className="mt-6 text-caption text-[var(--muted)]">Evaluation results depend on faculty-reviewed reference chunks and recorded model outputs. No score represents independent learning improvement or an official university grade.</p>
 </div>;
}
