'use client';
import { useRef, useEffect } from 'react';
import { cn } from '@/lib/cn';

const MAX = 500;

interface Props {
  onSend:              (text: string) => void;
  value:               string;
  onChange:            (val: string) => void;
  isRecording:         boolean;
  onToggleRecord:      () => void;
  recSeconds:          number;
  interimText?:        string;
  isSpeechSupported?:  boolean;
}

export const ChatInput = ({ onSend, value, onChange, isRecording, onToggleRecord, recSeconds, interimText = '', isSpeechSupported = true }: Props) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    if (!value.trim()) return;
    onSend(value.trim());
    onChange('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  useEffect(() => {
    const el = textareaRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 80) + 'px'; }
  }, [value, interimText]);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
  const displayValue = isRecording ? interimText : value;

  // Counter colour feedback
  const len = value.length;
  const counterClass = len >= MAX ? 'text-red-500 font-semibold' : len >= MAX * 0.85 ? 'text-amber-500' : 'text-[var(--muted2)]';

  return (
    <div className="px-4 pb-4 pt-3 border-t border-[var(--border)] bg-white shrink-0">

      {/* Recording bar */}
      {isRecording && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 mb-2">
          <div className="w-2 h-2 rounded-full bg-[var(--red)] animate-pulse shrink-0" />
          <span className="text-[13px] font-medium text-[var(--red)] flex-1 flex items-center gap-1.5">
            <i className="fas fa-microphone text-xs" />
            {interimText ? 'Transcribing…' : 'Listening — speak now…'}
          </span>
          <span className="text-[12px] text-[var(--muted)] tabular-nums">{fmt(recSeconds)}</span>
          {/* Affordance: labelled stop button, not just an × */}
          <button
            onClick={onToggleRecord}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-red-100 hover:bg-red-200 text-[var(--red)] text-[12px] font-semibold transition-colors"
          >
            <i className="fas fa-stop text-[9px]" /> Stop
          </button>
        </div>
      )}

      {/* Input box */}
      <div className={cn(
        'flex items-end gap-2 bg-[var(--surface)] border-2 rounded-3xl px-4 py-2 transition-all',
        isRecording
          ? 'border-red-300 bg-red-50'
          : 'border-[var(--border)] focus-within:border-indigo-500 focus-within:bg-white focus-within:ring-2 focus-within:ring-indigo-100'
      )}>
        <textarea
          ref={textareaRef}
          rows={1}
          value={displayValue}
          onChange={(e) => { if (!isRecording) onChange(e.target.value.slice(0, MAX)); }}
          onKeyDown={(e) => { if (!isRecording) handleKey(e); }}
          readOnly={isRecording}
          maxLength={MAX}
          placeholder={isRecording ? 'Speak — transcript appears here…' : 'Ask about this lecture…'}
          className="flex-1 bg-transparent border-none outline-none text-[15px] text-[var(--text)] placeholder:text-[var(--muted)] resize-none leading-relaxed py-2"
          style={{ maxHeight: 100, cursor: isRecording ? 'default' : 'text' }}
        />
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={isSpeechSupported ? onToggleRecord : undefined}
            disabled={!isSpeechSupported}
            title={!isSpeechSupported ? 'Voice input requires Chrome or Edge' : isRecording ? 'Stop recording' : 'Start voice input'}
            aria-label={isRecording ? 'Stop recording' : 'Start voice input'}
            className={cn(
              'w-9 h-9 rounded-full border flex items-center justify-center transition-all',
              !isSpeechSupported
                ? 'bg-white border-[var(--border)] text-[var(--muted)] opacity-40 cursor-not-allowed'
                : isRecording
                ? 'bg-red-100 border-[var(--red)] text-[var(--red)] animate-pulse'
                : 'bg-white border-[var(--border)] text-[var(--muted)] hover:border-indigo-500 hover:text-indigo-600 active:scale-95'
            )}
          >
            <i className="fas fa-microphone text-[14px]" />
          </button>

          <button
            onClick={handleSend}
            disabled={isRecording || !value.trim()}
            aria-label="Send message"
            className="w-9 h-9 rounded-full bg-indigo-600 text-white flex items-center justify-center hover:bg-indigo-700 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-indigo-600"
          >
            <i className="fas fa-paper-plane text-[13px]" />
          </button>
        </div>
      </div>

      {/* Hints row */}
      <div className="flex justify-between items-center px-1 mt-1.5">
        <span className="text-[11px] text-[var(--muted2)]">
          {isRecording
            ? <span className="text-red-400">Transcript appears here · press Enter or Send to submit</span>
            : <>
                <kbd className="bg-[var(--surface)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[11px]">Enter</kbd>
                <span className="mx-1">send</span>·
                <kbd className="bg-[var(--surface)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[11px] ml-1">⇧ Enter</kbd>
                <span className="ml-1">new line</span>
              </>
          }
        </span>
        {/* Constraint feedback: counter warns when near limit */}
        {!isRecording && (
          <span className={cn('text-[11px] tabular-nums transition-colors', counterClass)}>
            {len} / {MAX}
          </span>
        )}
      </div>
    </div>
  );
};
