import { AI_SUGGESTIONS } from '@/lib/constants';

const ICONS: Record<string, string> = {
  'What is a zero-shot prompt?': 'fas fa-lightbulb',
  'Give me an example prompt':   'fas fa-code',
  'Quiz me on this lecture':     'fas fa-circle-question',
  'Summarize key points':        'fas fa-list',
};

interface Props { onSelect: (text: string) => void }

export const SuggestionChips = ({ onSelect }: Props) => (
  <div className="border-t border-[var(--border)] shrink-0 px-5 pt-2.5 pb-3">
    <p className="text-[12px] font-semibold text-[var(--muted)] uppercase tracking-wider mb-2">
      Try asking
    </p>
    <div className="flex gap-2 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
      {AI_SUGGESTIONS.map((s) => (
        <button
          key={s}
          onClick={() => onSelect(s)}
          className="whitespace-nowrap flex-shrink-0 px-3.5 py-2 bg-white border border-[var(--border)] rounded-2xl text-[14px] text-[var(--muted)] flex items-center gap-2 hover:bg-indigo-50 hover:border-indigo-400 hover:text-indigo-700 active:scale-95 transition-all shadow-sm"
        >
          <i className={`${ICONS[s] ?? 'fas fa-star'} text-[12px]`} /> {s}
        </button>
      ))}
    </div>
  </div>
);
