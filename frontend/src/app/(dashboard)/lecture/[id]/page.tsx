'use client';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@apollo/client';
import { GET_LECTURE, GET_LECTURES } from '@/graphql/lecture.queries';
import { DBLecture } from '@/types';
import { MessageBubble }  from '@/components/chat/MessageBubble';
import { TypingIndicator } from '@/components/chat/TypingIndicator';
import { SuggestionChips } from '@/components/chat/SuggestionChips';
import { ChatInput }       from '@/components/chat/ChatInput';
import { ChatSidebar }     from '@/components/chat/ChatSidebar';
import { useChat }         from '@/hooks/useChat';
import { cn }              from '@/lib/cn';
import { useRouter }       from 'next/navigation';

const CHANNEL = {
  name:        'Fazal Qadir Khan Islamic Institute Pakistan',
  initials:    'FQ',
  subscribers: '3.05K',
};

interface Props { params: { id: string } }

export default function LecturePage({ params }: Props) {
  const router    = useRouter();
  const lectureId = parseInt(params.id, 10);

  const { data: lectureData, loading } = useQuery(GET_LECTURE, {
    variables: { id: params.id },
    skip: isNaN(lectureId),
  });

  const { data: allData } = useQuery(GET_LECTURES);

  const lecture: DBLecture | undefined = lectureData?.lecture;
  const allLectures: DBLecture[]       = allData?.lectures ?? [];

  const chat = useChat(
    lecture?.title ?? 'this lecture',
    lectureId,
    'AI Tutor'
  );

  const bottomRef                         = useRef<HTMLDivElement>(null);
  const prevAiCountRef                    = useRef(0);
  const [recSecs,     setRecSecs]     = useState(0);
  const [showSidebar, setShowSidebar] = useState(true);
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat.messages, chat.isTyping]);

  useEffect(() => {
    if (!chat.isRecording) { setRecSecs(0); return; }
    const id = setInterval(() => setRecSecs(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [chat.isRecording]);

  // Refresh sidebar after each new completed AI answer
  useEffect(() => {
    const aiCount = chat.messages.filter(
      m => m.role === 'ai' && m.id !== 'welcome' && !m.isStreaming
    ).length;
    if (aiCount > prevAiCountRef.current) {
      prevAiCountRef.current = aiCount;
      setSidebarRefreshKey(k => k + 1);
    }
  }, [chat.messages]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!lecture || isNaN(lectureId)) notFound();

  const isReady = lecture.status === 'READY';

  return (
    <div className="px-4 py-5">
      <div className="flex gap-5 items-start">

        {/* ── LEFT: Video + info (55%) ─────────────── */}
        <div className="w-[55%] shrink-0 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 100px)' }}>
          {/* Player */}
          <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-black shadow-md">
            {lecture.youtubeVideoId ? (
              <iframe
                src={`https://www.youtube.com/embed/${lecture.youtubeVideoId}?rel=0&modestbranding=1`}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                className="w-full h-full border-0"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-white">
                <i className="fas fa-video-slash text-4xl" />
              </div>
            )}
          </div>

          {/* Title */}
          <h1 className="text-[22px] font-bold leading-snug mt-4 mb-3">{lecture.title}</h1>

          {/* AI Status warning */}
          {!isReady && (
            <div className="mb-3 flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-2.5">
              <i className="fas fa-clock text-amber-500" />
              <span className="text-sm text-amber-700 font-medium">
                AI Tutor not yet available for this lecture (status: {lecture.status}).
              </span>
            </div>
          )}

          {/* Channel */}
          <div className="flex items-center gap-3 py-3 border-t border-b border-[var(--border)] mb-3">
            <div className="w-10 h-10 rounded-full bg-purple-600 flex items-center justify-center text-white text-sm font-bold shrink-0">
              {CHANNEL.initials}
            </div>
            <div className="flex-1">
              <p className="text-[15px] font-bold">{CHANNEL.name}</p>
              <p className="text-[13px] text-[var(--muted)]">{CHANNEL.subscribers} subscribers</p>
            </div>
            <button className="px-4 py-2 bg-[var(--text)] text-white rounded-xl text-[13px] font-bold hover:bg-gray-800 transition-colors">
              Subscribe
            </button>
          </div>

          {/* Description */}
          {lecture.description && (
            <div className="bg-[var(--surface)] rounded-xl p-3.5 text-[14px] text-[var(--muted)] leading-relaxed mb-4">
              {lecture.description}
            </div>
          )}

          {/* Other lectures */}
          {allLectures.length > 0 && (
            <div>
              <p className="text-[15px] font-bold text-[var(--text)] mb-2">
                Course Lectures <span className="text-[var(--muted)] font-normal">({allLectures.length})</span>
              </p>
              <div className="flex flex-col gap-1.5">
                {allLectures.map((lec, i) => {
                  const isActive = lec.id === params.id;
                  const isReady  = lec.status === 'READY';
                  return (
                    <div
                      key={lec.id}
                      onClick={() => isReady && !isActive && router.push(`/lecture/${lec.id}`)}
                      className={cn(
                        'flex gap-3 p-2.5 rounded-xl border transition-colors',
                        isActive
                          ? 'bg-blue-50 border-blue-200 cursor-default'
                          : isReady
                          ? 'bg-white border-[var(--border)] hover:bg-[var(--surface)] cursor-pointer'
                          : 'bg-white border-[var(--border)] opacity-60 cursor-default'
                      )}
                    >
                      <span className="w-5 text-[12px] font-bold text-[var(--muted)] shrink-0 mt-1 text-center">
                        {isActive
                          ? <i className="fas fa-play text-[10px] text-[var(--accent)]" />
                          : i + 1}
                      </span>
                      {lec.youtubeVideoId ? (
                        <div className="w-24 shrink-0 aspect-video rounded-lg overflow-hidden bg-black">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`https://i.ytimg.com/vi/${lec.youtubeVideoId}/hqdefault.jpg`}
                            alt={lec.title}
                            className="w-full h-full object-cover"
                          />
                        </div>
                      ) : (
                        <div className="w-24 shrink-0 aspect-video rounded-lg bg-[var(--surface)] flex items-center justify-center">
                          <i className="fas fa-video text-[var(--muted)]" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className={cn('text-[14px] font-semibold line-clamp-2 leading-snug', isActive && 'text-[var(--accent)]')}>
                          {lec.title}
                        </p>
                        <p className="text-[12px] text-[var(--muted)] mt-1">
                          {isReady ? '🟢 AI Ready' : '⏳ Preparing'}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT: Inline Chat ───────────────────── */}
        <div
          className="flex-1 min-w-0 bg-white rounded-xl border border-[var(--border)] shadow-md flex flex-col overflow-hidden relative"
          style={{ height: 'calc(100vh - 100px)' }}
        >
          {/* Chat header */}
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--border)] shrink-0">
            <div className="w-9 h-9 rounded-xl overflow-hidden shrink-0">
              <Image src="/agent-avatar.png" alt="AI Tutor" width={36} height={36} className="object-cover w-full h-full" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[15px] font-bold text-[var(--text)]">{chat.agentName}</p>
              <p className="text-[12px] text-[var(--muted)] truncate">
                {chat.isNewSession ? 'New session — full history preserved' : `Scoped to: ${lecture.title}`}
              </p>
            </div>


            {/* Auto-speak toggle */}
            <button
              onClick={chat.toggleAutoSpeak}
              title={chat.autoSpeak ? 'Auto-speak on — click to turn off' : 'Auto-speak off — click to turn on'}
              className={cn(
                'w-8 h-8 rounded-xl flex items-center justify-center transition-colors',
                chat.autoSpeak
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-[var(--surface)] text-[var(--muted)] hover:bg-purple-50 hover:text-[var(--accent)]'
              )}
            >
              <i className={`fas ${chat.autoSpeak ? 'fa-volume-high' : 'fa-volume-xmark'} text-[11px]`} />
            </button>

            {/* Mode toggle */}
            <div className="flex bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-0.5 gap-0.5">
              {(['text', 'voice'] as const).map(m => {
                const voiceDisabled = m === 'voice' && !chat.isSpeechSupported;
                return (
                  <button
                    key={m}
                    onClick={() => !voiceDisabled && chat.setMode(m)}
                    disabled={voiceDisabled}
                    title={voiceDisabled ? 'Voice requires Chrome or Edge' : undefined}
                    className={cn(
                      'px-3 py-1 rounded-xl text-[13px] font-semibold transition-all flex items-center gap-1.5',
                      chat.mode === m ? 'bg-[var(--accent)] text-white' : 'text-[var(--muted)]',
                      voiceDisabled && 'opacity-40 cursor-not-allowed'
                    )}
                  >
                    <i className={m === 'text' ? 'fas fa-keyboard text-[10px]' : 'fas fa-microphone text-[10px]'} />
                    {m.charAt(0).toUpperCase() + m.slice(1)}
                  </button>
                );
              })}
            </div>

          </div>


          {/* Speaking indicator */}
          {chat.isSpeaking && (
            <div className="flex items-center gap-2 bg-blue-50 border-b border-blue-100 px-4 py-2 shrink-0">
              <div className="flex items-end gap-[3px] h-4">
                {[1,2,3,4].map(i => (
                  <div key={i} className="w-[3px] bg-[var(--accent)] rounded-full animate-bounce"
                    style={{ height: `${8 + i * 3}px`, animationDelay: `${i * 0.1}s` }} />
                ))}
              </div>
              <span className="text-[13px] font-semibold text-[var(--accent)] flex-1">AI Tutor is speaking…</span>
              <button onClick={chat.stopSpeaking}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-100 hover:bg-blue-200 text-[var(--accent)] text-[12px] font-semibold transition-colors">
                <i className="fas fa-stop text-[9px]" /> Stop
              </button>
            </div>
          )}

          {/* Not ready state */}
          {!isReady ? (
            <div className="flex-1 flex flex-col items-center justify-center text-[var(--muted)] gap-3 px-6">
              <div className="w-14 h-14 rounded-2xl bg-amber-50 flex items-center justify-center">
                <i className="fas fa-clock text-amber-400 text-2xl" />
              </div>
              <p className="text-[16px] font-semibold text-slate-600 text-center">AI Agent Not Ready</p>
              <p className="text-[13px] text-center leading-relaxed">
                The AI tutor for this lecture is still being prepared. Check back once the status is <strong>AI Ready</strong>.
              </p>
            </div>
          ) : (
            <>
              {/* Messages */}
              <div className="flex-1 overflow-y-auto px-4 py-3.5 flex flex-col gap-3">
                <div className="flex items-center justify-center">
                  <span className="bg-[var(--surface)] text-[var(--muted)] text-[12px] px-3 py-1.5 rounded-xl flex items-center gap-1.5">
                    <i className="fas fa-circle-check text-[var(--accent)] text-[10px]" />
                    Agent ready — <strong className="text-[var(--accent)]">scoped to this lecture only</strong>
                  </span>
                </div>

                {chat.isLoadingHistory ? (
                  <div className="flex items-center justify-center py-4">
                    <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                    <span className="ml-2 text-[13px] text-[var(--muted)]">Loading history…</span>
                  </div>
                ) : (
                  chat.messages.map(msg => (
                    <MessageBubble
                      key={msg.id}
                      message={msg}
                      onSpeak={msg.role === 'ai' ? chat.speak : undefined}
                      isSpeaking={chat.isSpeaking}
                    />
                  ))
                )}

                {chat.isTyping && <TypingIndicator />}
                <div ref={bottomRef} />
              </div>

              <SuggestionChips onSelect={chat.sendMessage} />

              <ChatInput
                onSend={chat.sendMessage}
                isRecording={chat.isRecording}
                onToggleRecord={chat.toggleRecording}
                recSeconds={recSecs}
                interimText={chat.interimText}
                isSpeechSupported={chat.isSpeechSupported}
              />
            </>
          )}
        </div>

        {/* ── RIGHT: Chat History Sidebar ─────────── */}
        {showSidebar ? (
          <ChatSidebar
            lectureId={lectureId}
            onNewChat={chat.startNewSession}
            isNewSession={chat.isNewSession}
            refreshKey={sidebarRefreshKey}
            onClose={() => setShowSidebar(false)}
          />
        ) : (
          <button
            onClick={() => setShowSidebar(true)}
            title="Open chat history"
            className="w-7 h-7 shrink-0 self-start mt-[10px] rounded-lg flex items-center justify-center text-[var(--muted)] hover:bg-purple-50 hover:text-[var(--accent)] transition-colors"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.4"/>
              <line x1="5.5" y1="1.5" x2="5.5" y2="14.5" stroke="currentColor" strokeWidth="1.4"/>
            </svg>
          </button>
        )}

      </div>
    </div>
  );
}
