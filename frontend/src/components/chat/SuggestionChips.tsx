import { AI_SUGGESTIONS } from '@/lib/constants';

const ICONS: Record<string, string> = {
  'What is a zero-shot prompt?': 'fas fa-lightbulb',
  'Give me an example prompt':   'fas fa-code',
  'Quiz me on this lecture':     'fas fa-circle-question',
  'Summarize key points':        'fas fa-list',
};

interface Props { onSelect: (text: string) => void }

export const SuggestionChips = ({ onSelect }: Props) => (
  <div className="border-t border-[var(--border)] shrink-0 px-4 pt-2 pb-2.5">
    {/* Visibility: labelled section so user knows what these are */}
    <p className="text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wider mb-1.5">
      Try asking
    </p>
    <div className="flex gap-1.5 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
      {AI_SUGGESTIONS.map((s) => (
        <button
          key={s}
          onClick={() => onSelect(s)}
          /* Affordances: bg changes on hover + active scale press gives clear click feedback */
          className="whitespace-nowrap flex-shrink-0 px-3 py-1.5 bg-[var(--surface)] border border-[var(--border)] rounded-2xl text-[13px] text-[var(--muted)] flex items-center gap-1.5 hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-700 active:scale-95 transition-all"
        >
          <i className={`${ICONS[s] ?? 'fas fa-star'} text-[11px]`} /> {s}
        </button>
      ))}
    </div>
  </div>
);
