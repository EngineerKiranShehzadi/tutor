'use client';
import { MONITOR_WINDOWS, type MonitorWindow } from './monitor-api';

export function WindowToggle({ value, onChange }: { value: MonitorWindow; onChange: (w: MonitorWindow) => void }) {
  return (
    <div role="group" aria-label="Time window" className="inline-flex rounded-xl bg-white/10 border border-white/20 p-1">
      {MONITOR_WINDOWS.map((w) => (
        <button
          key={w}
          type="button"
          aria-pressed={w === value}
          onClick={() => onChange(w)}
          className={`px-4 py-1.5 rounded-lg text-[13px] font-semibold transition-colors ${
            w === value ? 'bg-white text-slate-900' : 'text-white/70 hover:text-white'
          }`}
        >
          {w}
        </button>
      ))}
    </div>
  );
}
