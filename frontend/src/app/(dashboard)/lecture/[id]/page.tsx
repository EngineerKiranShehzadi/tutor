'use client';
import { notFound } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@apollo/client';
import { GET_LECTURE, GET_LECTURES } from '@/graphql/lecture.queries';
import { DBLecture } from '@/types';
import { MessageBubble }  from '@/components/chat/MessageBubble';
import { TypingIndicator } from '@/components/chat/TypingIndicator';
import { ChatInput }       from '@/components/chat/ChatInput';
import { ChatSidebar }     from '@/components/chat/ChatSidebar';
import { useChat }         from '@/hooks/useChat';
import { useAvatarSpeech } from '@/hooks/useAvatarSpeech';
import { TeacherAvatarPanel } from '@/components/avatar/TeacherAvatarPanel';
import { deriveAvatarState } from '@/lib/avatar/avatar-state';
import { resolveAgentName } from '@/lib/avatar/agent-identity';
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

  // Displayed agent identity — resolved from the lecture's YouTube id via the
  // existing lecture -> agent mapping (no database ids hardcoded). The agent
  // that actually answers is still selected server-side from lecture_id.
  const agentName = resolveAgentName(lecture?.youtubeVideoId);

  // 3D teacher avatar: a presentation layer over the existing chat. It only
  // receives the final (guardrail-checked) answer text; it never changes it.
  const speech = useAvatarSpeech();
  const [avatarVisible, setAvatarVisible] = useState(true);
  const [avatarError, setAvatarError]     = useState(false);
  const avatarSpeaksRef = useRef(false);
  avatarSpeaksRef.current = avatarVisible && speech.supported;

  useEffect(() => {
    try { if (localStorage.getItem('askaitutor_avatar_visible') === 'false') setAvatarVisible(false); } catch { /* storage unavailable */ }
  }, []);

  const chat = useChat(
    lecture?.title ?? 'this lecture',
    lectureId,
    agentName,
    {
      // Returning true tells useChat the avatar speaks this answer, so the
      // built-in auto-speak is skipped (never two voices).
      onFinalAnswer: (answer) => {
        if (!avatarSpeaksRef.current) return false;
        setAvatarError(false);
        speech.speak(answer);
        return true;
      },
      onAnswerError: () => { speech.stop(); setAvatarError(true); },
    }
  );

  const bottomRef       = useRef<HTMLDivElement>(null);
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const [recSecs,       setRecSecs]       = useState(0);
  const [showSidebar,   setShowSidebar]   = useState(true);
  const [speakingMsgId, setSpeakingMsgId] = useState<string | null>(null);

  // Clear speakingMsgId when TTS finishes (built-in voice, or the avatar's voice when it is shown)
  const anySpeaking = avatarVisible ? speech.isSpeaking : chat.isSpeaking;
  useEffect(() => {
    if (!anySpeaking) setSpeakingMsgId(null);
  }, [anySpeaking]);

  // Switching lecture or chat session always stops the previous answer's speech.
  useEffect(() => {
    speech.stop();
    chat.stopSpeaking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lectureId, chat.currentSessionId]);

  // A speech failure (not just an answer failure) also surfaces as the ERROR state, briefly.
  useEffect(() => {
    if (speech.error) setAvatarError(true);
  }, [speech.error]);
  useEffect(() => {
    if (!avatarError) return;
    const id = setTimeout(() => setAvatarError(false), 4000);
    return () => clearTimeout(id);
  }, [avatarError]);

  const avatarState = deriveAvatarState({
    isAnswerPending:   chat.isAnswerPending,
    isSpeaking:        speech.isSpeaking,
    isUserInputActive: chat.inputText.trim().length > 0 || chat.isRecording,
    hasError:          avatarError,
  });

  const toggleAvatar = (visible: boolean) => {
    setAvatarVisible(visible);
    if (!visible) speech.stop();
    try { localStorage.setItem('askaitutor_avatar_visible', String(visible)); } catch { /* storage unavailable */ }
  };

  useEffect(() => {
    // Scroll only the messages list. (scrollIntoView also scrolls the
    // overflow-hidden chat panel itself, which clipped the chat header.)
    const el = chatMessagesRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [chat.messages, chat.isTyping]);

  useEffect(() => {
    if (!chat.isRecording) { setRecSecs(0); return; }
    const id = setInterval(() => setRecSecs(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [chat.isRecording]);

  // When user clicks a session in the sidebar, switch to it
  const handleSelectSession = useCallback((sessionId: number) => {
    chat.selectSession(sessionId);
  }, [chat.selectSession]);

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

        {/* ── RIGHT: Chat + Sidebar — one unified panel ── */}
        <div
          className="flex flex-1 min-w-0 bg-white rounded-xl border border-[var(--border)] shadow-md overflow-hidden"
          style={{ height: 'calc(100vh - 100px)' }}
        >
          {/* Chat panel */}
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden relative">
          {/* Speaking indicator */}
          {chat.isSpeaking && (
            <div className="flex items-center gap-2 bg-indigo-50 border-b border-indigo-100 px-5 py-2.5 shrink-0">
              <div className="flex items-end gap-[3px] h-5">
                {[1,2,3,4].map(i => (
                  <div key={i} className="w-[3px] bg-indigo-600 rounded-full animate-bounce"
                    style={{ height: `${8 + i * 3}px`, animationDelay: `${i * 0.1}s` }} />
                ))}
              </div>
              <span className="text-[14px] font-semibold text-indigo-700 flex-1">AI Tutor is speaking…</span>
              <button onClick={chat.stopSpeaking}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-100 hover:bg-indigo-200 text-indigo-700 text-[13px] font-semibold transition-colors">
                <i className="fas fa-stop text-[10px]" /> Stop
              </button>
            </div>
          )}

          {/* AI teacher avatar — shown on the right, at the top of the chat column.
              Additional to the text chat, never a replacement for it. */}
          {isReady && (
            avatarVisible ? (
              <TeacherAvatarPanel
                compact
                agentName={agentName}
                lectureTitle={lecture.title}
                state={avatarState}
                getMouth={speech.getMouth}
                speechSupported={speech.supported}
                isSpeaking={speech.isSpeaking}
                isPaused={speech.isPaused}
                muted={speech.muted}
                canReplay={speech.hasSpoken()}
                errorMessage={speech.error}
                onPlay={speech.replay}
                onPause={speech.pause}
                onResume={speech.resume}
                onStop={speech.stop}
                onToggleMute={speech.toggleMute}
                onHide={() => toggleAvatar(false)}
              />
            ) : (
              <div className="px-5 py-2 border-b border-[var(--border)] shrink-0 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => toggleAvatar(true)}
                  className="text-[13px] font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 rounded-xl px-3.5 py-1.5 transition-colors"
                >
                  <i className="fas fa-chalkboard-user mr-2 text-[12px]" />Show AI teacher
                </button>
                <span className="flex-1" />
                <button
                  onClick={chat.toggleAutoSpeak}
                  title={chat.autoSpeak ? 'Auto-speak on — click to turn off' : 'Auto-speak off — click to turn on'}
                  className={cn(
                    'w-9 h-9 rounded-xl flex items-center justify-center transition-colors',
                    chat.autoSpeak
                      ? 'bg-indigo-600 text-white'
                      : 'bg-[var(--surface)] text-[var(--muted)] hover:bg-indigo-50 hover:text-indigo-600'
                  )}
                >
                  <i className={`fas ${chat.autoSpeak ? 'fa-volume-high' : 'fa-volume-xmark'} text-[13px]`} />
                </button>
              </div>
            )
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
              <div ref={chatMessagesRef} className="flex-1 min-h-[180px] overflow-y-auto px-5 py-4 flex flex-col gap-4">
                <div className="flex items-center justify-center">
                  <span className="bg-indigo-50 border border-indigo-100 text-indigo-700 text-[13px] font-medium px-4 py-2 rounded-xl flex items-center gap-2">
                    <i className="fas fa-circle-check text-indigo-500 text-[11px]" />
                    Agent ready — <strong>scoped to this lecture only</strong>
                  </span>
                </div>

                {chat.isLoadingSession ? (
                  <div className="flex items-center justify-center py-6">
                    <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                    <span className="ml-2.5 text-[14px] text-[var(--muted)]">Loading history…</span>
                  </div>
                ) : (
                  chat.messages.map(msg => (
                    <div key={msg.id} data-msg-id={msg.id}>
                      <MessageBubble
                        message={msg}
                        onSpeak={msg.role === 'ai' ? (text) => {
                          setSpeakingMsgId(msg.id);
                          if (avatarSpeaksRef.current) {
                            chat.stopSpeaking();      // never two voices
                            speech.speak(text);
                          } else {
                            chat.speak(text);
                          }
                        } : undefined}
                        isSpeaking={speakingMsgId === msg.id && anySpeaking}
                      />
                    </div>
                  ))
                )}

                {chat.isTyping && <TypingIndicator />}
                <div ref={bottomRef} />
              </div>

              <ChatInput
                onSend={chat.sendMessage}
                value={chat.inputText}
                onChange={chat.setInputText}
                isRecording={chat.isRecording}
                onToggleRecord={chat.toggleRecording}
                recSeconds={recSecs}
                interimText={chat.interimText}
                isSpeechSupported={chat.isSpeechSupported}
                isAnswerPending={chat.isAnswerPending}
              />
            </>
          )}
          </div>{/* end chat panel */}

          {/* Sidebar — integrated into the same card, separated by a border */}
          {showSidebar && (
            <ChatSidebar
              lectureId={lectureId}
              activeSessionId={chat.currentSessionId}
              refreshKey={chat.sessionsRefreshKey}
              onNewChat={chat.createNewSession}
              onSelectSession={handleSelectSession}
              onClose={() => setShowSidebar(false)}
            />
          )}
        </div>{/* end unified panel */}

        {/* Toggle button when sidebar is collapsed — sits outside the panel */}
        {!showSidebar && (
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
