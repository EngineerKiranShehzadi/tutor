'use client';
import { useState, useCallback, useRef, useEffect } from 'react';
import { useMutation, useLazyQuery } from '@apollo/client';
import { ChatMessage, ChunkSource } from '@/types';
import { v4 as uuidv4 } from 'uuid';
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

export const useChat = (lectureTitle: string, lectureId: number, agentName: string) => {
  const [currentSessionId,  setCurrentSessionId]  = useState<number | null>(null);
  const [sessionMessages,   setSessionMessages]   = useState<ChatMessage[]>([]);
  const [localMessages,     setLocalMessages]     = useState<ChatMessage[]>([]);
  const [isTyping,          setTyping]            = useState(false);
  const [isLoadingSession,  setIsLoadingSession]  = useState(true);
  const [sessionsRefreshKey, setSessionsRefreshKey] = useState(0);
  const [inputText,         setInputText]         = useState('');
  const [autoSpeak,         setAutoSpeak]         = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('askaitutor_autospeak') === 'true';
  });

  const autoSpeakRef       = useRef(autoSpeak);
  const voiceSpeakRef      = useRef<(text: string) => void>(() => {});
  const streamTimerRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  // Ref so sendMessage always reads the latest session ID without becoming a dep
  const currentSessionRef  = useRef<number | null>(null);

  const [fetchSessions]        = useLazyQuery(CHAT_SESSIONS_QUERY,         { fetchPolicy: 'network-only' });
  const [fetchSessionHistory]  = useLazyQuery(SESSION_HISTORY_QUERY,       { fetchPolicy: 'network-only' });
  const [askLectureAgent]      = useMutation(ASK_LECTURE_AGENT_MUTATION);
  const [createSessionMut]     = useMutation(CREATE_CHAT_SESSION_MUTATION);

  const welcomeMsg: ChatMessage = {
    id:        'welcome',
    role:      'ai',
    type:      'text',
    content:   `Hi! I'm <strong>${agentName}</strong>, your AI tutor for <strong>${lectureTitle}</strong>. Ask me anything covered in this lecture!`,
    timestamp: new Date(0),
  };

  // ── Load messages for a session into state ────────────────
  const loadSessionMessages = useCallback(async (sessionId: number) => {
    const { data } = await fetchSessionHistory({ variables: { sessionId } });
    const entries: HistoryEntry[] = data?.sessionHistory ?? [];
    setSessionMessages(entries.flatMap(entryToMessages));
  }, [fetchSessionHistory]);

  // ── On mount: load most recent session or auto-create one ─
  useEffect(() => {
    if (!lectureId || isNaN(lectureId)) return;
    let cancelled = false;

    const init = async () => {
      setIsLoadingSession(true);
      try {
        const { data } = await fetchSessions({ variables: { lectureId } });
        if (cancelled) return;

        const sessions: ChatSession[] = data?.chatSessions ?? [];
        if (sessions.length > 0) {
          const latest = sessions[0];
          currentSessionRef.current = latest.id;
          setCurrentSessionId(latest.id);
          await loadSessionMessages(latest.id);
        } else {
          const { data: cd } = await createSessionMut({ variables: { lectureId } });
          if (cancelled) return;
          const ns = cd?.createChatSession as ChatSession | undefined;
          if (ns) {
            currentSessionRef.current = ns.id;
            setCurrentSessionId(ns.id);
            setSessionMessages([]);
          }
        }
      } catch (err) {
        console.error('[CHAT] Init error:', err);
      } finally {
        if (!cancelled) setIsLoadingSession(false);
      }
    };

    init();
    return () => { cancelled = true; };
  }, [lectureId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Select an existing session ────────────────────────────
  const selectSession = useCallback(async (sessionId: number) => {
    if (sessionId === currentSessionRef.current) return;
    if (streamTimerRef.current) {
      clearInterval(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    setLocalMessages([]);
    currentSessionRef.current = sessionId;
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
    setLocalMessages([]);
    setSessionMessages([]);
    try {
      const { data } = await createSessionMut({ variables: { lectureId } });
      const ns = data?.createChatSession as ChatSession | undefined;
      if (ns) {
        currentSessionRef.current = ns.id;
        setCurrentSessionId(ns.id);
        setSessionsRefreshKey(k => k + 1);
      }
    } catch (err) {
      console.error('[CHAT] Create session error:', err);
    }
  }, [lectureId, createSessionMut]);

  // ── Send a message in the current session ─────────────────
  const sendMessage = useCallback(
    async (content: string) => {
      const sessionId = currentSessionRef.current;
      if (!content.trim() || !sessionId) return;

      if (streamTimerRef.current) {
        clearInterval(streamTimerRef.current);
        streamTimerRef.current = null;
      }

      const userMsg: ChatMessage = {
        id: uuidv4(), role: 'user', type: 'text', content, timestamp: new Date(),
      };
      setLocalMessages(prev => [...prev, userMsg]);
      setTyping(true);
      console.log(`[CHAT] 📤 Session #${sessionId}: "${content.slice(0, 60)}..."`);

      try {
        const { data } = await askLectureAgent({
          variables: { input: { lectureId, question: content, sessionId } },
        });

        const response  = data?.askLectureAgent;
        const rawAnswer = response?.answer ?? FALLBACK_REPLY;
        const sources: ChunkSource[] = response?.sources ?? [];
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

        if (autoSpeakRef.current) {
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

      } catch (err) {
        console.error('[CHAT] ❌ Error:', err);
        setLocalMessages(prev => [...prev, {
          id: uuidv4(), role: 'ai', type: 'text', content: FALLBACK_REPLY, timestamp: new Date(),
        }]);
        setTyping(false);
      }
    },
    [lectureId, askLectureAgent]
  );

  // ── Voice ────────────────────────────────────────────────
  const voice = useVoice({ onTranscriptReady: setInputText, enabled: true });

  autoSpeakRef.current  = autoSpeak;
  voiceSpeakRef.current = voice.speak;

  useEffect(() => {
    return () => { if (streamTimerRef.current) clearInterval(streamTimerRef.current); };
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
