'use client';
import {useEffect,useState} from 'react';
import {useMutation,useQuery} from '@apollo/client';
import {GET_FACULTY_REVISION_PLANS,SAVE_REVISION_PLAN,WITHDRAW_REVISION_PLAN} from '@/graphql/revision-plan.queries';
type Plan={outcomeId:number;lectureId:number;guidance:string;status:string};
const input='w-full rounded-control border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-label text-[var(--text)] focus:border-[var(--accent)] outline-none';
export function FacultyRevisionEditor({courseId,outcomeId,code,lectureIds}:{courseId:number;outcomeId:number;code:string;lectureIds:number[]}){
 const plans=useQuery(GET_FACULTY_REVISION_PLANS,{variables:{courseId},fetchPolicy:'cache-and-network'});
 const current:Plan|undefined=(plans.data?.facultyRevisionPlans??[]).find((x:Plan)=>x.outcomeId===outcomeId);
 const [lectureId,setLectureId]=useState<number|null>(null);
 const [guidance,setGuidance]=useState('');
 const [dirty,setDirty]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [save]=useMutation(SAVE_REVISION_PLAN),[withdraw]=useMutation(WITHDRAW_REVISION_PLAN);
 useEffect(()=>{setDirty(false);setLectureId(null);setGuidance('');setNotice('');setError('');},[courseId,outcomeId]);
 useEffect(()=>{if(!dirty){setLectureId(current?.lectureId??lectureIds[0]??null);setGuidance(current?.guidance??'');}},[current?.lectureId,current?.guidance,lectureIds.join(','),dirty]);
 const valid=lectureId!==null&&lectureIds.includes(lectureId)&&guidance.trim().length>=15&&guidance.trim().length<=600;
 async function action(fn:()=>Promise<unknown>,message:string){
  if(pending)return;setPending(true);setError('');setNotice('');
  try{await fn();await plans.refetch();setDirty(false);setNotice(message);}
  catch(e){setError(e instanceof Error?e.message:'Could not save guidance.');}
  finally{setPending(false);}
 }
 return <section className="mt-4 border-t border-[var(--border)] pt-4">
  <h3 className="text-label font-semibold text-[var(--text)]">Approved revision · {code}</h3>
  <p className="text-caption text-[var(--muted)] mt-1">Drafts are private. Only approved guidance is shown to eligible students.</p>
  {current&&<p className="text-caption text-[var(--muted)] mt-2">Status: {current.status}</p>}
  {error&&<p role="alert" className="text-caption text-red-700 mt-2">{error}</p>}
  {notice&&<p role="status" className="text-caption text-[var(--accent)] mt-2">{notice}</p>}
  <label className="block text-caption text-[var(--text)] mt-3">Mapped lecture
   <select className={input+' mt-1'} value={lectureId??''} disabled={pending||lectureIds.length===0}
    onChange={e=>{setDirty(true);setLectureId(Number(e.target.value));}}>
    {!lectureIds.length&&<option value="">Map a lecture first</option>}
    {lectureIds.map(id=><option key={id} value={id}>Lecture {id}</option>)}
   </select>
  </label>
  <label className="block text-caption text-[var(--text)] mt-3">Faculty guidance
   <textarea className={input+' mt-1'} rows={2} value={guidance} maxLength={600} disabled={pending}
    onChange={e=>{setDirty(true);setGuidance(e.target.value);}} placeholder="Review this lecture and practise the concept again when ready."/>
  </label>
  <div className="flex gap-2 flex-wrap mt-3">
   <button type="button" disabled={!valid||pending} onClick={()=>void action(()=>save({variables:{courseId,outcomeId,lectureId,guidance:guidance.trim(),approve:false}}),'Draft saved.')}
    className="rounded-control border border-[var(--border)] px-4 py-2 text-caption font-semibold text-[var(--text)] disabled:opacity-40">Save draft</button>
   <button type="button" disabled={!valid||pending} onClick={()=>void action(()=>save({variables:{courseId,outcomeId,lectureId,guidance:guidance.trim(),approve:true}}),'Guidance approved.')}
    className="rounded-control bg-[var(--accent)] px-4 py-2 text-caption font-semibold text-white disabled:opacity-40">Approve for students</button>
   {current?.status==='APPROVED'&&<button type="button" disabled={pending} onClick={()=>void action(()=>withdraw({variables:{courseId,outcomeId}}),'Approval withdrawn.')}
    className="rounded-control border border-[var(--border)] px-4 py-2 text-caption text-[var(--text)]">Withdraw</button>}
  </div>
 </section>;
}
