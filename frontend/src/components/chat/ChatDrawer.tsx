'use client';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { MessageBubble }   from './MessageBubble';
import { TypingIndicator } from './TypingIndicator';
import { SuggestionChips } from './SuggestionChips';
import { ChatInput }       from './ChatInput';
import { ChatMessage }     from '@/types';
import { cn } from '@/lib/cn';

interface Props {
  isOpen:              boolean;
  onClose:             () => void;
  lectureTitle:        string;
  agentName:           string;
  messages:            ChatMessage[];
  isTyping:            boolean;
  isLoadingHistory?:   boolean;
  mode:                'text' | 'voice';
  onSetMode:           (m: 'text' | 'voice') => void;
  onSend:              (text: string) => void;
  onClearChat?:        () => void;
  isRecording:         boolean;
  onToggleRecord:      () => void;
  isSpeaking:          boolean;
  onStopSpeaking:      () => void;
  onSpeak:             (text: string) => void;
  interimText:         string;
  isSpeechSupported?:  boolean; // false on Firefox / Safari — disables voice mode tab
}

export const ChatDrawer = ({
  isOpen, onClose, lectureTitle, agentName, messages, isTyping,
  isLoadingHistory, mode, onSetMode, onSend, onClearChat,
  isRecording, onToggleRecord, isSpeaking, onStopSpeaking, onSpeak, interimText,
  isSpeechSupported = true,
}: Props) => {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [recSecs,       setRecSecs]       = useState(0);
  const [confirmClear,  setConfirmClear]  = useState(false);
  const [inputText,     setInputText]     = useState('');

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  useEffect(() => {
    if (!isRecording) { setRecSecs(0); return; }
    const id = setInterval(() => setRecSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [isRecording]);

  const handleClearChat = () => {
    if (!confirmClear) { setConfirmClear(true); return; }
    onClearChat?.();
    setConfirmClear(false);
  };

  return (
    <div
      className={cn(
        'fixed bottom-0 left-0 right-[340px] bg-white border-t-2 border-[var(--accent)] flex flex-col z-[200] shadow-2xl transition-transform duration-300',
        isOpen ? 'translate-y-0' : 'translate-y-full'
      )}
      style={{ height: 480 }}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--border)] shrink-0">
        <div className="w-9 h-9 rounded-xl overflow-hidden shrink-0">
          <Image src="/agent-avatar.png" alt="AI Tutor" width={36} height={36} className="object-cover w-full h-full" />
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-[14px] font-bold text-[var(--text)]">{agentName}</p>
          <p className="text-[11px] text-[var(--muted)] truncate">Answers only from: {lectureTitle}</p>
        </div>

        {/* Mode toggle */}
        <div className="flex bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-0.5 gap-0.5">
          {(['text', 'voice'] as const).map((m) => {
            const voiceDisabled = m === 'voice' && !isSpeechSupported;
            return (
              <button
                key={m}
                onClick={() => !voiceDisabled && onSetMode(m)}
                disabled={voiceDisabled}
                title={voiceDisabled ? 'Voice input requires Chrome or Edge' : undefined}
                className={cn(
                  'px-3 py-1 rounded-xl text-[12px] font-semibold transition-all flex items-center gap-1.5',
                  mode === m ? 'bg-[var(--accent)] text-white' : 'text-[var(--muted)]',
                  voiceDisabled && 'opacity-40 cursor-not-allowed'
                )}
              >
                <i className={m === 'text' ? 'fas fa-keyboard text-[10px]' : 'fas fa-microphone text-[10px]'} />
                {m.charAt(0).toUpperCase() + m.slice(1)}
              </button>
            );
          })}
        </div>

        {/* Clear chat */}
        {onClearChat && (
          <button
            onClick={handleClearChat}
            onBlur={() => setConfirmClear(false)}
            title={confirmClear ? 'Click again to confirm' : 'Clear chat history'}
            className={cn(
              'px-2.5 py-1.5 rounded-lg text-[11px] font-semibold transition-colors',
              confirmClear
                ? 'bg-red-100 text-red-600 hover:bg-red-200'
                : 'bg-[var(--surface)] text-[var(--muted)] hover:bg-gray-200'
            )}
          >
            <i className="fas fa-trash-can text-[10px]" />
            {confirmClear && <span className="ml-1">Sure?</span>}
          </button>
        )}

        <button
          onClick={onClose}
          className="w-8 h-8 rounded-full bg-[var(--surface)] flex items-center justify-center text-[var(--muted)] hover:bg-gray-200 transition-colors"
        >
          <i className="fas fa-xmark text-sm" />
        </button>
      </div>

      {/* Speaking indicator */}
      {isSpeaking && (
        <div className="flex items-center gap-2 bg-blue-50 border-b border-blue-100 px-4 py-2 shrink-0">
          <div className="flex items-end gap-[3px] h-4">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="w-[3px] bg-[var(--accent)] rounded-full animate-bounce"
                style={{ height: `${8 + i * 3}px`, animationDelay: `${i * 0.1}s` }}
              />
            ))}
          </div>
          <span className="text-[12px] font-semibold text-[var(--accent)] flex-1">AI Tutor is speaking...</span>
          <button
            onClick={onStopSpeaking}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-100 hover:bg-blue-200 text-[var(--accent)] text-[11px] font-semibold transition-colors"
          >
            <i className="fas fa-stop text-[9px]" /> Stop
          </button>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3.5 flex flex-col gap-3">
        <div className="flex items-center justify-center">
          <span className="bg-[var(--surface)] text-[var(--muted)] text-[11px] px-3 py-1.5 rounded-xl flex items-center gap-1.5">
            <i className="fas fa-circle-check text-[var(--accent)] text-[10px]" />
            Agent ready — <strong className="text-[var(--accent)]">scoped to this lecture only</strong>
          </span>
        </div>

        {isLoadingHistory ? (
          <div className="flex items-center justify-center py-4">
            <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
            <span className="ml-2 text-[12px] text-[var(--muted)]">Loading history…</span>
          </div>
        ) : (
          messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              onSpeak={msg.role === 'ai' ? onSpeak : undefined}
              isSpeaking={isSpeaking}
            />
          ))
        )}

        {isTyping && <TypingIndicator />}
        <div ref={bottomRef} />
      </div>

      {/* Suggestion chips */}
      <SuggestionChips onSelect={onSend} />

      {/* Input */}
      <ChatInput
        onSend={onSend}
        value={inputText}
        onChange={setInputText}
        isRecording={isRecording}
        onToggleRecord={onToggleRecord}
        recSeconds={recSecs}
        interimText={interimText}
        isSpeechSupported={isSpeechSupported}
      />
    </div>
  );
};
