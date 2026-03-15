import { AI_SUGGESTIONS } from '@/lib/constants';

const ICONS: Record<string, string> = {
  'What is a zero-shot prompt?': 'fas fa-lightbulb',
  'Give me an example prompt':   'fas fa-code',
  'Quiz me on this lecture':     'fas fa-circle-question',
  'Summarize key points':        'fas fa-list',
};

interface Props { onSelect: (text: string) => void }

export const SuggestionChips = ({ onSelect }: Props) => (
  <div className="flex gap-1.5 px-4 py-2 overflow-x-auto border-t border-[var(--border)] shrink-0" style={{ scrollbarWidth: 'none' }}>
    {AI_SUGGESTIONS.map((s) => (
      <button
        key={s}
        onClick={() => onSelect(s)}
        className="whitespace-nowrap px-3 py-1.5 bg-[var(--surface)] border border-[var(--border)] rounded-2xl text-[12px] text-[var(--muted)] flex items-center gap-1.5 shrink-0 hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors"
      >
        <i className={`${ICONS[s] ?? 'fas fa-star'} text-[10px]`} /> {s}
      </button>
    ))}
  </div>
);
