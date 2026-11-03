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
  // An answer is still being produced: sending is blocked (one question at a
  // time, so a student can't stack several pipelines), typing is not.
  isAnswerPending?:    boolean;
  /** Why voice input stopped, when there is something worth telling. */
  voiceError?:         string | null;
  onDismissVoiceError?: () => void;
}

export const ChatInput = ({ onSend, value, onChange, isRecording, onToggleRecord, recSeconds, interimText = '', isSpeechSupported = true, isAnswerPending = false, voiceError = null, onDismissVoiceError }: Props) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    if (isAnswerPending || !value.trim()) return;
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
  const counterClass = len >= MAX ? 'text-red-500 font-semibold' : len >= MAX * 0.85 ? 'text-[var(--gold)]' : 'text-[var(--muted2)]';

  return (
    <div className="px-4 pb-4 pt-3 border-t border-[var(--border)] bg-white shrink-0">

      {/* Why voice input stopped. Shown above the box, dismissible, and gone
          the moment listening starts again. Without this, every failure looked
          the same: "Listening", then silence. */}
      {!isRecording && voiceError && (
        <div className="flex items-start gap-2.5 bg-[var(--gold-soft)] border border-[#e6dcc0] rounded-card px-3 py-2.5 mb-2">
          <i className="fas fa-microphone-slash text-[var(--gold)] text-[12px] mt-0.5 shrink-0" />
          <span className="flex-1 text-[12px] leading-relaxed text-[var(--gold)]">{voiceError}</span>
          {onDismissVoiceError && (
            <button
              type="button"
              onClick={onDismissVoiceError}
              title="Dismiss"
              aria-label="Dismiss"
              className="w-5 h-5 rounded flex items-center justify-center text-[var(--gold)] hover:bg-[#f0e6cc] transition-colors shrink-0"
            >
              <i className="fas fa-xmark text-[11px]" />
            </button>
          )}
        </div>
      )}

      {/* Recording bar */}
      {isRecording && (
        <div className="flex items-center gap-2.5 bg-[var(--accent-soft)] border border-[var(--border)] rounded-card px-3 py-2 mb-2">
          <span className="w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse shrink-0" />
          <span className="text-[13px] font-medium text-[var(--accent-deep)] flex-1">
            {interimText ? 'Transcribing…' : 'Listening'}
          </span>
          <span className="text-[12px] text-[var(--muted)] tabular-nums">{fmt(recSeconds)}</span>
          <button
            onClick={onToggleRecord}
            className="flex items-center gap-1.5 h-7 px-3 rounded-control bg-white border border-[var(--border)] text-[var(--text)] text-[12px] font-semibold transition-colors hover:bg-[var(--surface)]"
          >
            <i className="fas fa-stop text-[9px]" /> Stop
          </button>
        </div>
      )}

      {/* Input box */}
      <div className={cn(
        'flex items-end gap-2 bg-[var(--surface)] border-2 rounded-3xl px-4 py-2 transition-all',
        isRecording
          ? 'border-[var(--accent)] bg-white'
          : 'border-[var(--border)] focus-within:border-[var(--accent)] focus-within:bg-white focus-within:ring-2 focus-within:ring-[var(--accent-soft)]'
      )}>
        {/* focus-visible:outline-none, not just outline-none: globals.css
            defines :focus-visible with a 2px accent outline AFTER
            @tailwind utilities, so it overrode the plain utility and drew a
            second green rectangle inside this box's own focus ring. The
            variant has higher specificity, so it wins. The box around it
            already shows focus through focus-within. */}
        <textarea
          ref={textareaRef}
          rows={1}
          value={displayValue}
          onChange={(e) => { if (!isRecording) onChange(e.target.value.slice(0, MAX)); }}
          onKeyDown={(e) => {
            if (isRecording) {
              // Enter ends the recording. It used to be swallowed entirely
              // while the hint below told the student to press it.
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onToggleRecord(); }
              return;
            }
            handleKey(e);
          }}
          readOnly={isRecording}
          maxLength={MAX}
          placeholder={isRecording ? 'Speak — transcript appears here…' : 'Ask about this lecture…'}
          className="flex-1 bg-transparent border-none outline-none focus-visible:outline-none text-[15px] text-[var(--text)] placeholder:text-[var(--muted)] resize-none leading-relaxed py-2"
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
                ? 'bg-[var(--accent-soft)] border-[var(--accent)] text-[var(--accent)] animate-pulse'
                : 'bg-white border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] active:scale-95'
            )}
          >
            <i className="fas fa-microphone text-[14px]" />
          </button>

          <button
            onClick={handleSend}
            disabled={isRecording || isAnswerPending || !value.trim()}
            title={isAnswerPending ? 'Wait for the current answer to finish' : undefined}
            aria-label="Send message"
            className="w-9 h-9 rounded-full bg-[var(--accent)] text-white flex items-center justify-center hover:bg-[var(--accent-deep)] active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[var(--accent)]"
          >
            <i className="fas fa-paper-plane text-[13px]" />
          </button>
        </div>
      </div>

      {/* Hints row */}
      <div className="flex justify-between items-center px-1 mt-1.5">
        <span className="text-[11px] text-[var(--muted2)]">
          {isRecording
            ? <span>Press Enter or Stop when you finish, then Enter again to send</span>
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
