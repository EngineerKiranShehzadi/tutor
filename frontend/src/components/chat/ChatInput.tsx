'use client';
import { useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/cn';

const MAX = 500;

interface Props {
  onSend:              (text: string) => void;
  isRecording:         boolean;
  onToggleRecord:      () => void;
  recSeconds:          number;
  interimText?:        string;
  isSpeechSupported?:  boolean;
}

export const ChatInput = ({ onSend, isRecording, onToggleRecord, recSeconds, interimText = '', isSpeechSupported = true }: Props) => {
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

  useEffect(() => {
    const el = textareaRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 80) + 'px'; }
  }, [text, interimText]);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
  const displayValue = isRecording ? interimText : text;

  // Counter colour feedback
  const len = text.length;
  const counterClass = len >= MAX ? 'text-red-500 font-semibold' : len >= MAX * 0.85 ? 'text-amber-500' : 'text-[var(--muted2)]';

  return (
    <div className="px-3 pb-3 pt-2.5 border-t border-[var(--border)] bg-white shrink-0">

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
        'flex items-end gap-1.5 bg-[var(--surface)] border-[1.5px] rounded-3xl px-3.5 py-1.5 transition-all',
        isRecording
          ? 'border-red-300 bg-red-50'
          : 'border-[var(--border)] focus-within:border-[var(--accent)] focus-within:bg-white focus-within:ring-2 focus-within:ring-blue-50'
      )}>
        <textarea
          ref={textareaRef}
          rows={1}
          value={displayValue}
          onChange={(e) => { if (!isRecording) setText(e.target.value.slice(0, MAX)); }}
          onKeyDown={(e) => { if (!isRecording) handleKey(e); }}
          readOnly={isRecording}
          maxLength={MAX}
          placeholder={isRecording ? 'Speak — transcript appears here…' : 'Ask about this lecture…'}
          className="flex-1 bg-transparent border-none outline-none text-[14px] text-[var(--text)] placeholder:text-[var(--muted2)] resize-none leading-relaxed py-1.5"
          style={{ maxHeight: 80, cursor: isRecording ? 'default' : 'text' }}
        />
        <div className="flex items-center gap-1 shrink-0">
          {/* Mic button — disabled state has cursor-not-allowed + tooltip */}
          <button
            onClick={isSpeechSupported ? onToggleRecord : undefined}
            disabled={!isSpeechSupported}
            title={!isSpeechSupported ? 'Voice input requires Chrome or Edge' : isRecording ? 'Stop recording' : 'Start voice input'}
            aria-label={isRecording ? 'Stop recording' : 'Start voice input'}
            className={cn(
              'w-8 h-8 rounded-full border flex items-center justify-center transition-all',
              !isSpeechSupported
                ? 'bg-white border-[var(--border)] text-[var(--muted)] opacity-40 cursor-not-allowed'
                : isRecording
                ? 'bg-red-100 border-[var(--red)] text-[var(--red)] animate-pulse'
                : 'bg-white border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] active:scale-95'
            )}
          >
            <i className="fas fa-microphone text-[13px]" />
          </button>

          {/* Send button — clearly disabled when empty */}
          <button
            onClick={handleSend}
            disabled={isRecording || !text.trim()}
            aria-label="Send message"
            className="w-8 h-8 rounded-full bg-[var(--accent)] text-white flex items-center justify-center hover:bg-blue-700 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[var(--accent)]"
          >
            <i className="fas fa-paper-plane text-[12px]" />
          </button>
        </div>
      </div>

      {/* Hints row */}
      <div className="flex justify-between items-center px-1 mt-1.5">
        <span className="text-[11px] text-[var(--muted2)]">
          {isRecording
            ? <span className="text-red-400">Auto-sends after silence · tap Stop to cancel</span>
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
