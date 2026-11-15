'use client';
import { MONITOR_WINDOWS, type MonitorWindow } from './monitor-api';

export function WindowToggle({ value, onChange }: { value: MonitorWindow; onChange: (w: MonitorWindow) => void }) {
  return (
    /* Was built for the old dark heading band: white on white/10, which on
       the light band is invisible. Same shape as the period control on
       Content Gaps, so the two pages read as one product. */
    <div role="group" aria-label="Time window" className="inline-flex rounded-control border border-[var(--border)] bg-[var(--card)] p-1">
      {MONITOR_WINDOWS.map((w) => (
        <button
          key={w}
          type="button"
          aria-pressed={w === value}
          onClick={() => onChange(w)}
          className={`px-3 py-1.5 rounded-control text-caption font-semibold transition-colors ${
            w === value ? 'bg-[var(--accent)] text-white' : 'text-[var(--muted)] hover:text-[var(--text)]'
          }`}
        >
          {w}
        </button>
      ))}
    </div>
  );
}
