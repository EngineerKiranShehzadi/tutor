'use client';
import { TUTORING_MODES, type TutoringMode } from '@/lib/tutoring-mode';
interface Props {value:TutoringMode;onChange:(value:TutoringMode)=>void;disabled?:boolean}
export function TutoringModeSelector({value,onChange,disabled=false}:Props){
 if(process.env.NEXT_PUBLIC_ADAPTIVE_TUTORING_MODES_ENABLED!=='true')return null;
 return <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-t border-[var(--border)] bg-[var(--card)]">
   <label htmlFor="tutoring-mode-selector" className="text-caption font-semibold text-[var(--muted)]">Teaching style</label>
   <select id="tutoring-mode-selector" value={value} disabled={disabled}
     onChange={e=>onChange(e.target.value as TutoringMode)}
     className="max-w-full min-w-0 rounded-control border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-caption font-semibold text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] disabled:opacity-50"
     aria-describedby="tutoring-mode-help">
     {TUTORING_MODES.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}
   </select>
   <span id="tutoring-mode-help" className="text-caption text-[var(--muted)]">
    {TUTORING_MODES.find(m=>m.id===value)?.help}
   </span>
 </div>;
}
