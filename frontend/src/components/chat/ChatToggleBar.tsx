interface Props {
  onOpen:       () => void;
  lectureTitle: string;   // full title, shown truncated
}

export const ChatToggleBar = ({ onOpen, lectureTitle }: Props) => (
  <div className="fixed bottom-0 left-0 right-[340px] bg-white border-t border-[var(--border)] px-6 py-2.5 flex items-center gap-3 z-50 shadow-[0_-2px_12px_rgba(0,0,0,0.06)]">
    <button
      onClick={onOpen}
      className="flex items-center gap-2 px-5 py-2 bg-[var(--accent)] text-white rounded-full text-[13px] font-bold hover:bg-blue-700 transition-colors shrink-0"
    >
      <i className="fas fa-robot text-sm" /> Ask AI Tutor
    </button>
    <span className="flex items-center gap-1.5 bg-green-50 border border-green-200 text-green-700 rounded-full px-3 py-1 text-[12px] font-semibold shrink-0">
      <i className="fas fa-shield-halved text-[10px]" /> AI Ready
    </span>
    <span className="text-[12px] text-[var(--muted)] truncate min-w-0">
      {lectureTitle}
    </span>
  </div>
);
