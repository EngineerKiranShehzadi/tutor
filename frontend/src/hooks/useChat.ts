'use client';
import { useState, useCallback, useRef, useEffect, createElement, Fragment } from 'react';
import { useMutation, useLazyQuery } from '@apollo/client';
import { ChatMessage, ChunkSource } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import { streamAsk, StreamUnavailableError, StreamRateLimitedError } from '@/lib/chat-stream';
import { ChatSessionGuard } from '@/lib/chat-session-guard';
import { useVoice } from './useVoice';
import {
  ASK_LECTURE_AGENT_MUTATION,
  CHAT_SESSIONS_QUERY,
  SESSION_HISTORY_QUERY,
  CREATE_CHAT_SESSION_MUTATION,
} from '@/graphql/chat.mutations';

interface HistoryEntry {
  id: number;
  question: string;
  answer: string;
  sources: ChunkSource[];
  createdAt: string;
}

export interface ChatSession {
  id:            number;
  title:         string;
  messageCount:  number;
  firstQuestion: string | null;
  createdAt:     string;
  updatedAt:     string;
}

const FALLBACK_REPLY = "I'm having trouble connecting. Please try again in a moment.";

// The server's own message when the per-student question limit was hit
// (stream: HTTP 429; GraphQL: extensions.code RATE_LIMITED), else null.
const rateLimitMessage = (err: unknown): string | null => {
  if (err instanceof StreamRateLimitedError) return err.message;
  const gql = (err as { graphQLErrors?: { message: string; extensions?: { code?: unknown } }[] })?.graphQLErrors;
  const hit = gql?.find(e => e.extensions?.code === 'RATE_LIMITED');
  return hit ? hit.message : null;
};

function entryToMessages(entry: HistoryEntry): ChatMessage[] {
  return [
    {
      id:        `db-user-${entry.id}`,
      role:      'user',
      type:      'text',
      content:   entry.question,
      timestamp: new Date(entry.createdAt),
    },
    {
      id:        `db-ai-${entry.id}`,
      role:      'ai',
      type:      'text',
      content:   entry.answer,
      sources:   entry.sources,
      citation:  entry.sources?.[0]?.startTime
        ? `Lecture content · ${entry.sources[0].startTime}`
        : 'Lecture content',
      timestamp: new Date(entry.createdAt),
    },
  ];
}

export interface UseChatOptions {
  /**
   * Called with the server's FINAL (guardrail-checked) answer text once it is
   * known — never with a streamed draft. Return true when the caller speaks it
   * itself (e.g. the 3D teacher avatar), so the built-in auto-speak is skipped
   * and two voices never play at once.
   */
  onFinalAnswer?: (answer: string) => boolean | void;
  /** Called when no answer could be obtained (stream and GraphQL fallback both failed). */
  onAnswerError?: () => void;
}

export const useChat = (lectureTitle: string, lectureId: number, agentName: string, options?: UseChatOptions) => {
  const [currentSessionId,  setCurrentSessionId]  = useState<number | null>(null);
  const [sessionMessages,   setSessionMessages]   = useState<ChatMessage[]>([]);
  const [localMessages,     setLocalMessages]     = useState<ChatMessage[]>([]);
  const [isTyping,          setTyping]            = useState(false);
  const [isLoadingSession,  setIsLoadingSession]  = useState(true);
  // true from the moment a question is sent until its final answer (or failure) is known
  const [isAnswerPending,   setAnswerPending]    = useState(false);
  const optionsRef          = useRef<UseChatOptions | undefined>(options);
  optionsRef.current       = options;
  const [sessionsRefreshKey, setSessionsRefreshKey] = useState(0);
  const [inputText,         setInputText]         = useState('');
  const [autoSpeak,         setAutoSpeak]         = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('askaitutor_autospeak') === 'true';
  });

  const autoSpeakRef       = useRef(autoSpeak);
  const voiceSpeakRef      = useRef<(text: string) => void>(() => {});
  const streamTimerRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  // Aborts an in-flight live stream when the user switches/creates a session
  const streamAbortRef      = useRef<AbortController | null>(null);
  // Single source of truth for "which session may be used now". A session
  // belongs to one lecture; the guard drops it the moment the lecture changes
  // and refuses stale async results (see lib/chat-session-guard.ts).
  const sessionGuardRef    = useRef<ChatSessionGuard>(new ChatSessionGuard());

  const [fetchSessions]        = useLazyQuery(CHAT_SESSIONS_QUERY,         { fetchPolicy: 'network-only' });
  const [fetchSessionHistory]  = useLazyQuery(SESSION_HISTORY_QUERY,       { fetchPolicy: 'network-only' });
  const [askLectureAgent]      = useMutation(ASK_LECTURE_AGENT_MUTATION);
  const [createSessionMut]     = useMutation(CREATE_CHAT_SESSION_MUTATION);

  const welcomeMsg: ChatMessage = {
    id:        'welcome',
    role:      'ai',
    type:      'text',
    content:   `Hi! I'm ${agentName}, your AI tutor for ${lectureTitle}. Ask me anything covered in this lecture!`,
    // React elements, not an HTML string: agentName and lectureTitle are admin
    // data and are escaped like any other text.
    richContent: createElement(Fragment, null,
      "Hi! I'm ", createElement('strong', null, agentName),
      ', your AI tutor for ', createElement('strong', null, lectureTitle),
      '. Ask me anything covered in this lecture!'),
    timestamp: new Date(0),
  };

  // ── Load messages for a session into state ────────────────
  const loadSessionMessages = useCallback(async (sessionId: number) => {
    const { data } = await fetchSessionHistory({ variables: { sessionId } });
    // A response for a session that stopped being the active one (the
    // student switched lecture/session meanwhile) must not replace the
    // messages now on screen.
    if (sessionGuardRef.current.activeSessionId() !== sessionId) return;
    const entries: HistoryEntry[] = data?.sessionHistory ?? [];
    setSessionMessages(entries.flatMap(entryToMessages));
  }, [fetchSessionHistory]);

  // ── On mount / lecture change: load most recent session or auto-create one ─
  useEffect(() => {
    const guard = sessionGuardRef.current;
    // A chat session belongs to exactly one lecture. The moment the lecture
    // changes, drop the previous lecture's session and anything in flight for
    // it — before the new lecture's sessions have loaded — so nothing can be
    // submitted against (or restored from) the old lecture.
    const token = guard.begin(lectureId);
    if (streamTimerRef.current) {
      clearInterval(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    setTyping(false);
    setAnswerPending(false);
    setCurrentSessionId(null);
    setSessionMessages([]);
    setLocalMessages([]);

    if (!lectureId || isNaN(lectureId)) return;

    const init = async () => {
      setIsLoadingSession(true);
      try {
        const { data } = await fetchSessions({ variables: { lectureId } });
        if (!guard.isCurrent(token)) return;

        const sessions: ChatSession[] = data?.chatSessions ?? [];
        if (sessions.length > 0) {
          const latest = sessions[0];
          if (!guard.activate(token, latest.id)) return;
          setCurrentSessionId(latest.id);
          await loadSessionMessages(latest.id);
        } else {
          const { data: cd } = await createSessionMut({ variables: { lectureId } });
          if (!guard.isCurrent(token)) return;
          const ns = cd?.createChatSession as ChatSession | undefined;
          if (ns && guard.activate(token, ns.id)) {
            setCurrentSessionId(ns.id);
            setSessionMessages([]);
          }
        }
      } catch (err) {
        console.error('[CHAT] Init error:', err);
      } finally {
        if (guard.isCurrent(token)) setIsLoadingSession(false);
      }
    };

    init();
  }, [lectureId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Select an existing session ────────────────────────────
  const selectSession = useCallback(async (sessionId: number) => {
    if (sessionId === sessionGuardRef.current.activeSessionId()) return;
    if (streamTimerRef.current) {
      clearInterval(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    setTyping(false);
    setLocalMessages([]);
    sessionGuardRef.current.activate(sessionGuardRef.current.currentToken(), sessionId);
    setCurrentSessionId(sessionId);
    setIsLoadingSession(true);
    try {
      await loadSessionMessages(sessionId);
    } finally {
      setIsLoadingSession(false);
    }
  }, [loadSessionMessages]);

  // ── Create a new session and switch to it ─────────────────
  const createNewSession = useCallback(async () => {
    if (streamTimerRef.current) {
      clearInterval(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    setTyping(false);
    setLocalMessages([]);
    setSessionMessages([]);
    // Token taken before the await: if the lecture changes while the new
    // session is being created, it must not become the active session.
    const token = sessionGuardRef.current.currentToken();
    try {
      const { data } = await createSessionMut({ variables: { lectureId } });
      const ns = data?.createChatSession as ChatSession | undefined;
      if (ns && sessionGuardRef.current.activate(token, ns.id)) {
        setCurrentSessionId(ns.id);
        setSessionsRefreshKey(k => k + 1);
      }
    } catch (err) {
      console.error('[CHAT] Create session error:', err);
    }
  }, [lectureId, createSessionMut]);

  // Typewriter animation for answers that arrive whole (greetings, summaries,
  // cached answers, guardrail fallbacks, or the GraphQL fallback path).
  const animateAnswer = useCallback((rawAnswer: string, sources: ChunkSource[], speakHandled = false) => {
    const citation = sources.length > 0 && sources[0].startTime
      ? `Lecture content · ${sources[0].startTime}`
      : 'Lecture content';

    const words = rawAnswer.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const msgId = uuidv4();

    setLocalMessages(prev => [...prev, {
      id: msgId, role: 'ai', type: 'text',
      content: '', citation, sources, timestamp: new Date(),
      isStreaming: true,
    }]);
    setTyping(false);

    if (autoSpeakRef.current && !speakHandled) {
      voiceSpeakRef.current(rawAnswer);
    }

    let idx = 0;
    streamTimerRef.current = setInterval(() => {
      idx++;
      const partial = words.slice(0, idx).join(' ');
      setLocalMessages(prev =>
        prev.map(m => m.id === msgId ? { ...m, content: partial } : m)
      );
      if (idx >= words.length) {
        clearInterval(streamTimerRef.current!);
        streamTimerRef.current = null;
        setLocalMessages(prev =>
          prev.map(m => m.id === msgId ? { ...m, content: rawAnswer, isStreaming: false } : m)
        );
        // Refresh sidebar so session title + updated_at update
        setSessionsRefreshKey(k => k + 1);
        console.log(`[CHAT] ✅ Stream complete (${rawAnswer.length} chars)`);
      }
    }, 35);
  }, []);

  // ── Send a message in the current session ─────────────────
  // Primary path: live SSE stream — the draft answer appears as the model
  // writes it, then the server's final (guardrail-checked) answer replaces
  // it. If the stream endpoint is unreachable before any response, falls
  // back to the regular GraphQL mutation (with the typewriter animation).
  const sendMessage = useCallback(
    async (content: string) => {
      // Only a session activated for THIS lecture is ever returned (null while
      // a lecture switch is still loading), so a stale id is never submitted.
      const sessionId = sessionGuardRef.current.sessionFor(lectureId);
      if (!content.trim() || !sessionId) return;
      // Identifies the lecture selection this request belongs to; a reply that
      // arrives after the student switched lecture is discarded below.
      const requestToken = sessionGuardRef.current.currentToken();

      if (streamTimerRef.current) {
        clearInterval(streamTimerRef.current);
        streamTimerRef.current = null;
      }
      streamAbortRef.current?.abort();
      const controller = new AbortController();
      streamAbortRef.current = controller;

      const userMsg: ChatMessage = {
        id: uuidv4(), role: 'user', type: 'text', content, timestamp: new Date(),
      };
      setLocalMessages(prev => [...prev, userMsg]);
      setTyping(true);
      setAnswerPending(true);
      console.log(`[CHAT] 📤 Session #${sessionId}: "${content.slice(0, 60)}..."`);

      let liveMsgId: string | null = null;
      let liveText = '';
      const updateLive = (patch: Partial<ChatMessage>) => {
        if (!liveMsgId) return;
        const id = liveMsgId;
        setLocalMessages(prev => prev.map(m => m.id === id ? { ...m, ...patch } : m));
      };

      try {
        const result = await streamAsk(
          { lectureId, sessionId, question: content },
          {
            onDelta: text => {
              liveText += text;
              if (!liveMsgId) {
                const id = uuidv4();
                liveMsgId = id;
                setTyping(false);
                setLocalMessages(prev => [...prev, {
                  id, role: 'ai', type: 'text', content: liveText,
                  timestamp: new Date(), isStreaming: true,
                }]);
              } else {
                updateLive({ content: liveText });
              }
            },
            onReset: () => { liveText = ''; updateLive({ content: '' }); },
          },
          controller.signal
        );
        if (controller.signal.aborted) return;
        if (!sessionGuardRef.current.isCurrent(requestToken)) return;

        const sources = result.sources;
        // Final, guardrail-checked answer: offer it to the avatar (if any).
        const speakHandled = optionsRef.current?.onFinalAnswer?.(result.answer) === true;
        if (liveMsgId) {
          // Server's final answer is authoritative — it may differ from the
          // streamed draft if the output guardrail revised or replaced it.
          updateLive({
            content: result.answer,
            sources,
            citation: sources.length > 0 && sources[0].startTime
              ? `Lecture content · ${sources[0].startTime}`
              : 'Lecture content',
            isStreaming: false,
          });
          if (autoSpeakRef.current && !speakHandled) voiceSpeakRef.current(result.answer);
          setSessionsRefreshKey(k => k + 1);
          console.log(`[CHAT] ✅ Live stream complete (${result.answer.length} chars)`);
        } else {
          // Nothing streamed (greeting, summary, cached answer, not-found…)
          animateAnswer(result.answer, sources, speakHandled);
        }
        return;
      } catch (err) {
        if (controller.signal.aborted || (err as Error).name === 'AbortError') return;
        let errorReply = rateLimitMessage(err) ?? FALLBACK_REPLY;

        // Stream never started → the server did not answer, so the GraphQL
        // path is a safe fallback (it also handles access-token refresh).
        if (err instanceof StreamUnavailableError && !liveMsgId) {
          console.warn('[CHAT] ⚠️ Stream unavailable, falling back to GraphQL:', (err as Error).message);
          try {
            const { data } = await askLectureAgent({
              variables: { input: { lectureId, question: content, sessionId } },
            });
            if (!sessionGuardRef.current.isCurrent(requestToken)) return;
            const response = data?.askLectureAgent;
            if (response?.answer) {
              const handled = optionsRef.current?.onFinalAnswer?.(response.answer) === true;
              animateAnswer(response.answer, response.sources ?? [], handled);
            } else {
              optionsRef.current?.onAnswerError?.();
              animateAnswer(FALLBACK_REPLY, []);
            }
            return;
          } catch (gqlErr) {
            console.error('[CHAT] ❌ Error:', gqlErr);
            errorReply = rateLimitMessage(gqlErr) ?? FALLBACK_REPLY;
          }
        } else {
          console.error('[CHAT] ❌ Stream error:', err);
        }

        optionsRef.current?.onAnswerError?.();
        if (liveMsgId) {
          updateLive({ content: errorReply, isStreaming: false });
        } else {
          setLocalMessages(prev => [...prev, {
            id: uuidv4(), role: 'ai', type: 'text', content: errorReply, timestamp: new Date(),
          }]);
        }
        setTyping(false);
      } finally {
        // Only the request that belongs to the current lecture selection may clear the flag.
        if (sessionGuardRef.current.isCurrent(requestToken)) setAnswerPending(false);
      }
    },
    [lectureId, askLectureAgent, animateAnswer]
  );

  // ── Voice ────────────────────────────────────────────────
  const voice = useVoice({ onTranscriptReady: setInputText, enabled: true });

  autoSpeakRef.current  = autoSpeak;
  voiceSpeakRef.current = voice.speak;

  useEffect(() => {
    return () => {
      if (streamTimerRef.current) clearInterval(streamTimerRef.current);
      streamAbortRef.current?.abort();
    };
  }, []);

  const toggleAutoSpeak = useCallback(() => {
    setAutoSpeak(prev => {
      const next = !prev;
      localStorage.setItem('askaitutor_autospeak', String(next));
      if (!next) voice.stopSpeaking();
      return next;
    });
  }, [voice.stopSpeaking]); // eslint-disable-line react-hooks/exhaustive-deps

  const messages: ChatMessage[] = [welcomeMsg, ...sessionMessages, ...localMessages];

  return {
    messages,
    isTyping,
    isLoadingSession,
    isAnswerPending,
    currentSessionId,
    sessionsRefreshKey,
    inputText,
    setInputText,
    sendMessage,
    selectSession,
    createNewSession,
    agentName,
    autoSpeak,
    toggleAutoSpeak,
    isRecording:       voice.isListening,
    isSpeaking:        voice.isSpeaking,
    interimText:       voice.interimText,
    toggleRecording:   voice.toggleListening,
    speak:             voice.speak,
    stopSpeaking:      voice.stopSpeaking,
    isSpeechSupported: voice.isSupported.stt,
  };
};
