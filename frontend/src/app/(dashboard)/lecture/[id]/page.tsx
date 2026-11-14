'use client';
import { TutoringModeSelector } from '@/components/chat/TutoringModeSelector';
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
import { LECTURES } from '@/lib/constants';
import { cn }              from '@/lib/cn';
import { sortLectures, statusBadge, isLectureReady, notReadyMessage } from '@/lib/lectures';
import { useRouter }       from 'next/navigation';

const CHANNEL = {
  name:        'Fazal Qadir Khan Islamic Institute Pakistan',
  initials:    'FQ',
  subscribers: '3.05K',
};

/**
 * Is this description just the title again?
 *
 * Lectures were imported with the description set to the title, but not always
 * character for character: one says "Lecture 5 | Prompt Engineering…" and the
 * other "Lecture 5 — Prompt Engineering…". Comparing the raw strings therefore
 * let the repeat through, so punctuation, spacing and case are stripped before
 * the two are compared and only the words decide.
 */
const wordsOnly = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
const sameAsTitle = (description: string, title: string) =>
  wordsOnly(description) === wordsOnly(title);

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
  // Course order, not insertion order. Unsorted, this list opened with
  // Lecture 6 at the top and numbered the rows 1..7 by position, so the
  // numbers described the accident of insertion rather than the course.
  const allLectures: DBLecture[]       = sortLectures((allData?.lectures ?? []).filter((l: DBLecture) => l.courseId === lecture?.courseId));

  // Displayed agent identity — resolved from the lecture's YouTube id via the
  // existing lecture -> agent mapping (no database ids hardcoded). The agent
  // that actually answers is still selected server-side from lecture_id.
  const agentName = lecture?.agentName || resolveAgentName(lecture?.youtubeVideoId);

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
      //
      // An answer is only spoken on its own when the question was asked out
      // loud, or when the student has turned auto-speak on. Every answer used
      // to be read aloud the moment the avatar was on screen, which meant a
      // typed question got an unasked-for voice — and the student's own
      // auto-speak setting was ignored.
      onFinalAnswer: (answer, { spokenQuestion }) => {
        if (!avatarSpeaksRef.current) return false;
        // The avatar speaks only what was asked out loud. It used to also
        // obey the auto-speak preference — but that preference's toggle is
        // rendered only while the avatar is HIDDEN, so with the avatar on
        // screen the setting was stuck at whatever it had been left at and
        // there was no control anywhere to turn it off. A typed question is
        // answered in silence; the speaker under the answer reads it on
        // request. Auto-speak still governs the plain browser voice, which is
        // used when the avatar is hidden — exactly when its toggle is visible.
        if (!spokenQuestion) return false;
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

  // "Ask again" sits under each of the student's own questions, so any one of
  // them can be re-asked — not just the latest. The answer arrives as a new
  // exchange at the bottom; the original stays where it is. Hidden while an
  // answer is in flight, so a second pipeline cannot be stacked on the first.

  // The newest answer already on screen. After a reload nothing has been
  // spoken yet, so the play button sat greyed out beside a page full of
  // answers and only came alive once one had been read aloud. It now plays the
  // last answer in the conversation, which is what pressing play looks like it
  // should do. The welcome notice is skipped: it is not something the tutor said.
  // In a chat with no answers yet the tutor's opening greeting is what play
  // reads, so a new chat starts with a working button instead of a dead one.
  // A real answer always wins over it.
  const lastAnswer = ([...chat.messages].reverse()
    .find(m => m.role === 'ai' && m.id !== 'welcome' && !m.isStreaming)?.content)
    ?? chat.messages.find(m => m.id === 'welcome')?.content
    ?? null;

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

  const isReady = isLectureReady(lecture.status);
  const isOriginalPlaylistVideo = LECTURES.some(l => l.videoId === lecture.youtubeVideoId);

  return (
    <div className="px-4 py-5">
      <div className="flex gap-5 items-start">

        {/* ── LEFT: Video + info (55%) ─────────────── */}
        <div className="w-[55%] shrink-0 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 100px)' }}>
          {/* Player */}
          <div className="relative w-full aspect-video rounded-card overflow-hidden bg-black shadow-md">
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
            <div className="mb-3 flex items-center gap-2 bg-[var(--gold-soft)] border border-[#e6dcc0] rounded-card px-3.5 py-2.5">
              <i className="fas fa-clock text-[var(--gold)]" />
              <span className="text-sm text-[var(--gold)] font-medium">
                {notReadyMessage(lecture.status)}
              </span>
            </div>
          )}

          {/* Original playlist attribution only; do not mislabel other instructors. */}
          {isOriginalPlaylistVideo && <div className="flex items-center gap-3 py-3 border-t border-b border-[var(--border)] mb-3">
            <div className="w-10 h-10 rounded-full bg-[var(--accent)] flex items-center justify-center text-white text-sm font-bold shrink-0">
              {CHANNEL.initials}
            </div>
            <div className="flex-1">
              <p className="text-[15px] font-bold">{CHANNEL.name}</p>
              <p className="text-[13px] text-[var(--muted)]">{CHANNEL.subscribers} subscribers</p>
            </div>
            <button className="px-4 py-2 bg-[var(--text)] text-white rounded-card text-[13px] font-bold hover:bg-gray-800 transition-colors">
              Subscribe
            </button>
          </div>}

          {/* Description. Many lectures were imported with the description set
              to the title, which printed the same sentence twice under each
              other. A description that only repeats the heading says nothing,
              so it is not shown; a real one still is. */}
          {lecture.description && sameAsTitle(lecture.description, lecture.title) === false && (
            <div className="bg-[var(--surface)] rounded-card p-3.5 text-[14px] text-[var(--muted)] leading-relaxed mb-4">
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
                  const isReady  = isLectureReady(lec.status);
                  const badge    = statusBadge(lec.status);
                  return (
                    <div
                      key={lec.id}
                      onClick={() => isReady && !isActive && router.push(`/lecture/${lec.id}`)}
                      className={cn(
                        'group flex gap-3 p-2.5 rounded-card border transition-colors',
                        isActive
                          ? 'bg-[var(--accent-soft)] border-[var(--border)] cursor-default'
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
                        <div className="w-[76px] shrink-0 aspect-video rounded-control overflow-hidden bg-black border border-[var(--border)]">
                          {/* Held slightly muted until the row is hovered, for
                              the same reason as the lecture list: the artwork
                              belongs to the video, not to our palette. */}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`https://i.ytimg.com/vi/${lec.youtubeVideoId}/hqdefault.jpg`}
                            alt={lec.title}
                            className="w-full h-full object-cover saturate-[.7] opacity-90 transition duration-200 group-hover:saturate-100 group-hover:opacity-100"
                          />
                        </div>
                      ) : (
                        <div className="w-[76px] shrink-0 aspect-video rounded-control bg-[var(--surface)] border border-[var(--border)] flex items-center justify-center">
                          <i className="fas fa-video text-[var(--muted)]" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className={cn('text-[14px] font-semibold line-clamp-2 leading-snug', isActive && 'text-[var(--accent)]')}>
                          {lec.title}
                        </p>
                        {/* Identical to the lectures list: ready is the ordinary
                            case for every row, so it is not labelled at all.
                            Only a lecture that is NOT ready gets a badge. */}
                        {isReady ? null : (
                          <span className={`mt-1 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${badge.color}`}>
                            <i className="fas fa-clock text-[9px]" />
                            {badge.label}
                          </span>
                        )}
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
          className="flex flex-1 min-w-0 bg-white rounded-card border border-[var(--border)] shadow-md overflow-hidden"
          style={{ height: 'calc(100vh - 100px)' }}
        >
          {/* Chat panel */}
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden relative">
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
                canReplay={!!lastAnswer}
                errorMessage={speech.error}
                // Pressing play while muted is a request to hear the answer, so
                // it unmutes first. Otherwise the button appears to do nothing.
                // Always the newest answer in the chat that is open. Replaying
                // "whatever was last spoken" meant opening a new chat and
                // pressing play read out an answer from the previous one,
                // because the speech engine remembers across sessions and the
                // chat does not.
                onPlay={() => {
                  if (speech.muted) speech.toggleMute();
                  if (lastAnswer) speech.speak(lastAnswer);
                }}
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
                  className="text-[13px] font-semibold text-[var(--accent-deep)] bg-[var(--accent-soft)] hover:bg-[var(--accent-soft)] border border-[var(--border)] rounded-card px-3.5 py-1.5 transition-colors"
                >
                  <i className="fas fa-chalkboard-user mr-2 text-[12px]" />Show AI teacher
                </button>

              </div>
            )
          )}

          {/* Not ready state */}
          {!isReady ? (
            <div className="flex-1 flex flex-col items-center justify-center text-[var(--muted)] gap-3 px-6">
              <div className="w-14 h-14 rounded-card bg-[var(--gold-soft)] flex items-center justify-center">
                <i className="fas fa-clock text-[var(--gold)] text-2xl" />
              </div>
              <p className="text-[16px] font-semibold text-[var(--muted)] text-center">Tutor not ready yet</p>
              <p className="text-[13px] text-center leading-relaxed max-w-[320px]">
                {notReadyMessage(lecture.status)}
              </p>
            </div>
          ) : (
            <>
              {/* Messages */}
              <div ref={chatMessagesRef} className="flex-1 min-h-[180px] overflow-y-auto px-5 py-4 flex flex-col gap-4">
                <div className="flex items-center justify-center">
                  <span className="bg-[var(--accent-soft)] border border-[var(--border)] text-[var(--accent-deep)] text-[13px] font-medium px-4 py-2 rounded-card flex items-center gap-2">
                    <i className="fas fa-circle-check text-[var(--accent)] text-[11px]" />
                    Agent ready — <strong>scoped to this lecture only</strong>
                  </span>
                </div>

                {chat.isLoadingSession ? (
                  <div className="flex items-center justify-center py-6">
                    <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                    <span className="ml-2.5 text-[14px] text-[var(--muted)]">Loading history…</span>
                  </div>
                ) : (
                  chat.messages.map(msg => (
                    <div key={msg.id} data-msg-id={msg.id}>
                      <MessageBubble
                        message={msg}
                        onSpeak={msg.role === 'ai' ? (text) => {
                          // A second press stops it. The button reads "Stop
                          // reading" while speaking, but used to restart the
                          // answer from the beginning instead of stopping it.
                          if (speakingMsgId === msg.id && anySpeaking) {
                            speech.stop();
                            chat.stopSpeaking();
                            setSpeakingMsgId(null);
                            return;
                          }
                          // Pressing the speaker under an answer is a request to
                          // hear it, so it overrides mute. Without this the
                          // answer was read at volume zero while this icon said
                          // it was speaking and the avatar's button said muted.
                          if (speech.muted) speech.toggleMute();
                          setSpeakingMsgId(msg.id);
                          if (avatarSpeaksRef.current) {
                            chat.stopSpeaking();      // never two voices
                            speech.speak(text);
                          } else {
                            chat.speak(text);
                          }
                        } : undefined}
                        isSpeaking={speakingMsgId === msg.id && anySpeaking}
                        onAskAgain={
                          msg.role === 'user' && !chat.isAnswerPending
                            ? () => chat.sendMessage(msg.content)
                            : undefined
                        }
                      />
                    </div>
                  ))
                )}

                {chat.isTyping && <TypingIndicator />}
                <div ref={bottomRef} />
              </div>

              <TutoringModeSelector value={chat.tutoringMode} onChange={chat.setTutoringMode} disabled={chat.isAnswerPending}/>
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
            className="w-7 h-7 shrink-0 self-start mt-[10px] rounded-control flex items-center justify-center text-[var(--muted)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] transition-colors"
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
