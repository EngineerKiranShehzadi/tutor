'use client';
import Image from 'next/image';
import { useState } from 'react';

import { ChatMessage } from '@/types';
import { renderAnswer } from '@/lib/format-answer';
import { cn } from '@/lib/cn';

interface Props {
  message:  ChatMessage;
  onSpeak?: (text: string) => void;
  isSpeaking?: boolean;
  /** Re-asks this question. Given to a student's own message, so any question
   *  in the conversation can be asked again, not only the last one. The fresh
   *  answer arrives as a new exchange at the bottom — the earlier one is left
   *  where it is, so the history stays a true record of what was asked when. */
  onAskAgain?: () => void;
}

/**
 * One action under an answer. Icon only, 28px square, no border — three
 * labelled buttons in a row would weigh more than the answer itself. Each
 * carries a title and an aria-label, so the meaning is available on hover and
 * to a screen reader.
 */
function Action({ icon, label, onClick, active = false }: {
  icon: string; label: string; onClick: () => void; active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'w-6 h-6 rounded-control inline-flex items-center justify-center transition-colors',
        active
          ? 'text-[var(--accent)] bg-[var(--accent-soft)]'
          : 'text-[var(--muted2)] hover:text-[var(--accent)] hover:bg-[var(--accent-soft)]'
      )}
    >
      <i className={cn(icon, 'text-[12px]')} />
    </button>
  );
}

export const MessageBubble = ({ message, onSpeak, isSpeaking, onAskAgain }: Props) => {
  const isUser   = message.role === 'user';
  const time     = message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // Hovering the time shows the day and date, with no time in it: the time is
  // already printed below every question and answer, so repeating it there
  // would say nothing new.
  const dayAndDate = message.timestamp.toLocaleDateString([], {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const [copied, setCopied] = useState(false);

  const copyAnswer = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be refused; silently leave the icon unchanged
      // rather than showing a tick for something that did not happen.
    }
  };

  // Unique timestamps only — shown as separate UI, never read aloud
  const timestampedSources = Array.from(
    new Map(
      (message.sources ?? [])
        .filter(s => s.startTime)
        .map(s => [`${s.startTime}-${s.endTime}`, s])
    ).values()
  );

  return (
    <div className={`flex gap-3 items-end ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* Only the tutor gets a face. A student's own messages are already
          identified by being green and on the right — their initials beside
          every question added nothing and made each one look top-heavy. */}
      {!isUser && (
        <div className="w-10 h-10 rounded-card shrink-0 overflow-hidden">
          <Image src="/agent-avatar.png" alt="AI Tutor" width={40} height={40} className="object-cover w-full h-full" />
        </div>
      )}

      {/* Content */}
      <div className={`max-w-[78%] flex flex-col gap-1 ${isUser ? 'items-end' : ''}`}>
        <div
          className={`px-4 py-3 rounded-card text-[16px] leading-relaxed ${
            isUser
              ? 'bg-[var(--accent)] text-white rounded-br-sm'
              : 'bg-white text-[var(--text)] rounded-bl-sm border border-[var(--border)] shadow-sm'
          }`}
        >
          {message.isStreaming ? (
            <>
              <span className="whitespace-pre-wrap break-words">{message.content}</span>
              <span
                className="inline-block w-[2px] h-[14px] bg-[var(--accent)] ml-[3px] align-middle rounded-sm animate-pulse"
              />
            </>
          ) : isUser ? (
            // A student's own text is never interpreted: what they typed is
            // exactly what they see.
            <span className="whitespace-pre-wrap break-words">{message.content}</span>
          ) : (
            // React elements, never an HTML string: React escapes every text
            // node, so dataset content and model output cannot become markup.
            message.richContent ?? renderAnswer(message.content)
          )}
        </div>

        {/* Lecture timestamps — visual only, NOT part of spoken text */}
        {!isUser && !message.isStreaming && timestampedSources.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-0.5">
            {timestampedSources.map((src, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-control bg-[var(--gold-soft)] border border-[#e6dcc0] text-[var(--gold)] text-[12px] font-semibold"
                title={src.topic ?? 'Lecture segment'}
              >
                <i className="fas fa-film text-[10px]" />
                {src.startTime}{src.endTime ? ` – ${src.endTime}` : ''}
              </span>
            ))}
          </div>
        )}

        {/* Answer actions */}
        {!isUser && !message.isStreaming && (
          <div className="flex items-center gap-0 ml-0.5">
            {onSpeak && (
              <Action
                icon={isSpeaking ? 'fas fa-volume-high' : 'fas fa-volume-low'}
                label={isSpeaking ? 'Stop reading' : 'Read aloud'}
                active={isSpeaking}
                onClick={() => onSpeak(message.content)}
              />
            )}
            <Action
              icon={copied ? 'fas fa-check' : 'fas fa-copy'}
              label={copied ? 'Copied' : 'Copy answer'}
              active={copied}
              onClick={copyAnswer}
            />
          </div>
        )}

        {/* The student's own question: one action, to ask it again. Nothing
            else — this is a record of what was asked, not a draft. */}
        {isUser && onAskAgain && (
          <div className="flex items-center gap-0 mr-0.5">
            <Action icon="fas fa-rotate-right" label="Ask this again" onClick={onAskAgain} />
          </div>
        )}

        {/* The welcome message is a system notice, not something anyone said:
            the browser rebuilds it on every page load and it is not in
            chat_history, so it cannot carry the time the conversation began.
            Stamping it with "now" would put a later time above older messages. */}
        {message.id !== 'welcome' && (
          <span
            className={`w-fit text-[12px] text-[var(--muted2)] px-0.5 cursor-default ${isUser ? 'self-end' : 'self-start'}`}
            title={dayAndDate}
          >
            {time}
          </span>
        )}
      </div>
    </div>
  );
};
