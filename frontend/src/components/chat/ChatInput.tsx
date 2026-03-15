'use client';
import { useState, useRef, useEffect } from 'react';

interface Props {
  onSend:         (text: string) => void;
  isRecording:    boolean;
  onToggleRecord: () => void;
  recSeconds:     number;
  interimText?:   string;
}

export const ChatInput = ({ onSend, isRecording, onToggleRecord, recSeconds, interimText = '' }: Props) => {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    if (!text.trim()) return;
    onSend(text.trim());
    setText('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  // Resize textarea on text change
  useEffect(() => {
    const el = textareaRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 80) + 'px'; }
  }, [text, interimText]);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  // Show live transcript while recording, otherwise typed text
  const displayValue = isRecording ? interimText : text;

  return (
    <div className="px-3 pb-3 pt-2.5 border-t border-[var(--border)] bg-white shrink-0">
      {/* Recording bar */}
      {isRecording && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 mb-2">
          <div className="w-2 h-2 rounded-full bg-[var(--red)] animate-pulse" />
          <span className="text-sm font-medium text-[var(--red)] flex-1 flex items-center gap-1.5">
            <i className="fas fa-microphone text-xs" />
            {interimText ? 'Transcribing...' : 'Listening — speak now...'}
          </span>
          <span className="text-xs text-[var(--muted)]">{fmt(recSeconds)}</span>
          <button onClick={onToggleRecord} className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-red-100 transition-colors text-[var(--muted)]">
            <i className="fas fa-xmark text-xs" />
          </button>
        </div>
      )}

      {/* Input box */}
      <div className={`flex items-end gap-1.5 bg-[var(--surface)] border-[1.5px] rounded-3xl px-3.5 py-1.5 transition-all ${
        isRecording ? 'border-red-300 bg-red-50' : 'border-[var(--border)] focus-within:border-[var(--accent)] focus-within:bg-white'
      }`}>
        <textarea
          ref={textareaRef}
          rows={1}
          value={displayValue}
          onChange={(e) => { if (!isRecording) setText(e.target.value); }}
          onKeyDown={(e) => { if (!isRecording) handleKey(e); }}
          readOnly={isRecording}
          placeholder={isRecording ? 'Speak — transcript appears here...' : 'Ask about this lecture...'}
          className="flex-1 bg-transparent border-none outline-none text-[13.5px] text-[var(--text)] placeholder:text-[var(--muted2)] resize-none leading-relaxed py-1.5"
          style={{ maxHeight: 80, cursor: isRecording ? 'default' : 'text' }}
        />
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onToggleRecord}
            title={isRecording ? 'Stop recording' : 'Start voice input'}
            className={`w-8 h-8 rounded-full border flex items-center justify-center transition-all ${
              isRecording
                ? 'bg-red-100 border-[var(--red)] text-[var(--red)]'
                : 'bg-white border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]'
            }`}
          >
            <i className={`fas fa-microphone text-[13px] ${isRecording ? 'animate-pulse' : ''}`} />
          </button>
          <button
            onClick={handleSend}
            disabled={isRecording || !text.trim()}
            className="w-8 h-8 rounded-full bg-[var(--accent)] text-white flex items-center justify-center hover:bg-blue-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <i className="fas fa-paper-plane text-[12px]" />
          </button>
        </div>
      </div>

      <div className="flex justify-between px-1 mt-1">
        <span className="text-[10px] text-[var(--muted2)]">
          {isRecording
            ? <span className="text-red-400">Auto-sends after silence · <i className="fas fa-xmark" /> to cancel</span>
            : <><kbd className="bg-[var(--surface)] border border-[var(--border)] rounded px-1 text-[10px]">Enter</kbd> send &nbsp;·&nbsp;
               <kbd className="bg-[var(--surface)] border border-[var(--border)] rounded px-1 text-[10px]">Shift+Enter</kbd> new line</>
          }
        </span>
        <span className="text-[10px] text-[var(--muted2)]">{isRecording ? '' : `${text.length} / 500`}</span>
      </div>
    </div>
  );
};
