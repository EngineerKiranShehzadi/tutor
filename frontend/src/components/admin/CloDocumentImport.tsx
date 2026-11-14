'use client';
import {useState} from 'react';
import api from '@/lib/api';

type Lecture={id:number;title:string};
type Outcome={code:string;description:string;lectureIds:number[]};
type Preview={outcomes:Outcome[];lectures:Lecture[];warnings:string[]};
const field='w-full rounded-control border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-label text-[var(--text)]';
export function CloDocumentImport({courseId,onApproved}:{courseId:number|null;onApproved:()=>Promise<unknown>}){
 const [file,setFile]=useState<File|null>(null);
 const [preview,setPreview]=useState<Preview|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const update=(index:number,changes:Partial<Outcome>)=>setPreview(p=>p?{...p,outcomes:p.outcomes.map((o,i)=>i===index?{...o,...changes}:o)}:p);
 async function extract(){
  if(!file||courseId===null)return;
  setBusy(true);setError('');setNotice('');setPreview(null);
  try{
   const data=new FormData();data.append('file',file);
   const response=await api.post<{data:Preview}>(`/clo-documents/preview/${courseId}`,data,{headers:{'Content-Type':'multipart/form-data'}});
   setPreview(response.data.data);
  }catch(e:any){setError(e?.response?.data?.message??e?.message??'Could not read CLO document.');}
  finally{setBusy(false);}
 }
 async function approve(){
  if(!preview||courseId===null||busy)return;
  if(!window.confirm('Approve these CLO definitions and selected lecture mappings? Existing CLO performance will not be deleted.'))return;
  setBusy(true);setError('');setNotice('');
  try{
   await api.post(`/clo-documents/approve/${courseId}`,{outcomes:preview.outcomes});
   await onApproved();
   setNotice('CLO definitions and lecture mappings approved. Future quizzes can use approved CLO scope.');
   setPreview(null);
  }catch(e:any){setError(e?.response?.data?.message??e?.message??'Could not approve CLO mappings.');}
  finally{setBusy(false);}
 }
 return <section className="rounded-card border border-[var(--border)] bg-[var(--card)] p-5 mb-5">
  <h2 className="text-h3 font-semibold text-[var(--text)]">Import CLO document</h2>
  <p className="text-caption text-[var(--muted)] mt-2 mb-4">Upload a course CLO PDF or DOCX. AI suggests the outcomes and matches them to existing lecture material. Review and approve before use in quiz generation; uploaded content is not used as answer evidence.</p>
  <div className="flex flex-wrap gap-3 items-center">
   <input aria-label="CLO document" className="text-label" type="file" accept=".pdf,.docx" disabled={busy||courseId===null} onChange={e=>{setFile(e.target.files?.[0]??null);setPreview(null);setNotice('');}}/>
   <button type="button" disabled={!file||courseId===null||busy} onClick={()=>void extract()} className="rounded-control bg-[var(--accent)] text-white font-semibold px-4 py-2 text-label disabled:opacity-50">{busy?'Processing…':'Analyze document'}</button>
  </div>
  {error&&<p role="alert" className="mt-3 text-label text-red-700">{error}</p>}
  {notice&&<p role="status" className="mt-3 text-label text-[var(--accent)]">{notice}</p>}
  {preview&&<div className="mt-5 border-t border-[var(--border)] pt-4">
   <h3 className="text-label font-semibold text-[var(--text)]">Review AI suggestions — not yet saved</h3>
   {preview.warnings.map((w,i)=><p key={i} className="mt-2 text-caption text-[var(--muted)]">{w}</p>)}
   <div className="space-y-4 mt-4">
    {preview.outcomes.map((o,i)=><article key={i} className="p-4 rounded-control border border-[var(--border)]">
     <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-3">
      <label className="text-caption">Code<input aria-label={'CLO code '+(i+1)} className={field+' mt-1'} maxLength={32} value={o.code} onChange={e=>update(i,{code:e.target.value})}/></label>
      <label className="text-caption">Learning outcome<textarea aria-label={'CLO description '+(i+1)} className={field+' mt-1'} rows={2} maxLength={1000} value={o.description} onChange={e=>update(i,{description:e.target.value})}/></label>
     </div>
     <fieldset className="mt-3"><legend className="text-caption font-semibold">Suggested lecture mappings — confirm relevant lectures</legend>
      <div className="grid gap-2 mt-2">{preview.lectures.map(l=><label key={l.id} className="flex gap-2 items-center text-caption">
       <input type="checkbox" checked={o.lectureIds.includes(l.id)} onChange={e=>update(i,{lectureIds:e.target.checked?[...o.lectureIds,l.id]:o.lectureIds.filter(x=>x!==l.id)})}/>
       {l.title}
      </label>)}</div>
     </fieldset>
    </article>)}
   </div>
   <div className="flex gap-3 mt-4">
    <button type="button" disabled={busy} onClick={()=>void approve()} className="rounded-control bg-[var(--accent)] px-4 py-2 text-white text-label font-semibold disabled:opacity-50">Approve CLOs and mappings</button>
    <button type="button" disabled={busy} onClick={()=>setPreview(null)} className="rounded-control border border-[var(--border)] px-4 py-2 text-label">Cancel</button>
   </div>
  </div>}
 </section>;
}
