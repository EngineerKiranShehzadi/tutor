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

  return (
    <div className={`flex gap-2 items-end ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* Avatar */}
      <div className={`w-[26px] h-[26px] rounded-lg shrink-0 overflow-hidden flex items-center justify-center ${isUser ? 'bg-[var(--red)]' : ''}`}>
        {isUser ? (
          <span className="text-white text-[10px] font-bold">{initials}</span>
        ) : (
          <Image src="/agent-avatar.png" alt="AI Tutor" width={26} height={26} className="object-cover w-full h-full" />
        )}
      </div>

      {/* Content */}
      <div className={`max-w-[80%] flex flex-col gap-1 ${isUser ? 'items-end' : ''}`}>
        <div
          className={`px-3 py-2.5 rounded-2xl text-[13px] leading-relaxed ${
            isUser
              ? 'bg-[var(--accent)] text-white rounded-br-sm'
              : 'bg-[var(--surface)] text-[var(--text)] rounded-bl-sm border border-[var(--border)]'
          }`}
          dangerouslySetInnerHTML={{ __html: message.content }}
        />

        {/* AI message actions */}
        {!isUser && (
          <div className="flex items-center gap-1.5">
            {message.citation && (
              <span className="inline-flex items-center gap-1.5 bg-blue-50 border border-blue-200 text-[var(--accent)] rounded-lg px-2 py-1 text-[11px]">
                <i className="fas fa-circle-check text-[9px]" /> {message.citation}
              </span>
            )}
            {onSpeak && (
              <button
                onClick={() => onSpeak(message.content)}
                title="Read aloud"
                className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold border transition-colors ${
                  isSpeaking
                    ? 'bg-blue-100 border-blue-300 text-[var(--accent)] animate-pulse'
                    : 'bg-[var(--surface)] border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]'
                }`}
              >
                <i className={`fas ${isSpeaking ? 'fa-volume-high' : 'fa-volume-low'} text-[9px]`} />
                {isSpeaking ? 'Speaking...' : 'Speak'}
              </button>
            )}
          </div>
        )}

        <span className="text-[10px] text-[var(--muted2)] px-0.5">{time}</span>
      </div>
    </div>
  );
};
