'use client';
import Image from 'next/image';

import { ChatMessage } from '@/types';
import { useAuth } from '@/hooks/useAuth';

interface Props {
  message:  ChatMessage;
  onSpeak?: (text: string) => void;
  isSpeaking?: boolean;
}

export const MessageBubble = ({ message, onSpeak, isSpeaking }: Props) => {
  const { user } = useAuth();
  const isUser   = message.role === 'user';
  const initials = user?.name?.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() ?? 'U';
  const time     = message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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
      {/* Avatar */}
      <div className="w-10 h-10 rounded-xl shrink-0 overflow-hidden">
        {isUser ? (
          user?.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={user.avatar_url} alt={user.name} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full bg-indigo-600 flex items-center justify-center">
              <span className="text-white text-[13px] font-bold">{initials}</span>
            </div>
          )
        ) : (
          <Image src="/agent-avatar.png" alt="AI Tutor" width={40} height={40} className="object-cover w-full h-full" />
        )}
      </div>

      {/* Content */}
      <div className={`max-w-[78%] flex flex-col gap-1.5 ${isUser ? 'items-end' : ''}`}>
        <div
          className={`px-4 py-3 rounded-2xl text-[16px] leading-relaxed ${
            isUser
              ? 'bg-indigo-600 text-white rounded-br-sm'
              : 'bg-white text-[var(--text)] rounded-bl-sm border border-[var(--border)] shadow-sm'
          }`}
        >
          {message.isStreaming ? (
            <>
              <span className="whitespace-pre-wrap break-words">{message.content}</span>
              <span
                className="inline-block w-[2px] h-[14px] bg-indigo-500 ml-[3px] align-middle rounded-sm animate-pulse"
              />
            </>
          ) : (
            <span dangerouslySetInnerHTML={{ __html: message.content }} />
          )}
        </div>

        {/* Lecture timestamps — visual only, NOT part of spoken text */}
        {!isUser && !message.isStreaming && timestampedSources.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-0.5">
            {timestampedSources.map((src, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-[12px] font-semibold"
                title={src.topic ?? 'Lecture segment'}
              >
                <i className="fas fa-film text-[10px]" />
                {src.startTime}{src.endTime ? ` – ${src.endTime}` : ''}
              </span>
            ))}
          </div>
        )}

        {/* AI message actions */}
        {!isUser && !message.isStreaming && (
          <div className="flex items-center gap-2">
            {onSpeak && (
              <button
                onClick={() => onSpeak(message.content)}
                title="Read aloud"
                className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[13px] font-semibold border transition-colors ${
                  isSpeaking
                    ? 'bg-indigo-100 border-indigo-300 text-indigo-600 animate-pulse'
                    : 'bg-white border-[var(--border)] text-[var(--muted)] hover:border-indigo-400 hover:text-indigo-600 hover:bg-indigo-50'
                }`}
              >
                <i className={`fas ${isSpeaking ? 'fa-volume-high' : 'fa-volume-low'} text-[11px]`} />
                {isSpeaking ? 'Speaking...' : 'Speak'}
              </button>
            )}
          </div>
        )}

        <span className="text-[12px] text-[var(--muted2)] px-0.5">{time}</span>
      </div>
    </div>
  );
};
