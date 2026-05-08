'use client';
import { useState, useCallback, useRef, useEffect } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { ChatMessage, ChunkSource } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import { useVoice } from './useVoice';
import {
  ASK_LECTURE_AGENT_MUTATION,
  CLEAR_CHAT_MUTATION,
  CHAT_HISTORY_QUERY,
} from '@/graphql/chat.mutations';

interface HistoryEntry {
  id: number;
  question: string;
  answer: string;
  sources: ChunkSource[];
  createdAt: string;
}

const FALLBACK_REPLY = "I'm having trouble connecting. Please try again in a moment.";

export const useChat = (lectureTitle: string, lectureId: number, agentName: string) => {
  const [localMessages, setLocalMessages] = useState<ChatMessage[]>([]);
  const [isTyping,      setTyping]      = useState(false);
  const [isOpen,        setOpen]        = useState(false);
  const [mode,          setMode]        = useState<'text' | 'voice'>('text');
  const [isNewSession,  setIsNewSession] = useState(false);
  const [autoSpeak,     setAutoSpeak]   = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('askaitutor_autospeak') === 'true';
  });
  // Refs so sendMessage can read current values without going into its deps array
  const autoSpeakRef   = useRef(autoSpeak);
  const voiceModeRef   = useRef<'text' | 'voice'>(mode);
  const voiceSpeakRef  = useRef<(text: string) => void>(() => {});
  const streamTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: historyData, loading: historyLoading, refetch: refetchHistory } = useQuery(
    CHAT_HISTORY_QUERY,
    { variables: { lectureId }, skip: !lectureId, fetchPolicy: 'network-only' }
  );

  const [askLectureAgent]  = useMutation(ASK_LECTURE_AGENT_MUTATION);
  const [clearChatMutation] = useMutation(CLEAR_CHAT_MUTATION);

  const welcomeMsg: ChatMessage = {
    id:        'welcome',
    role:      'ai',
    type:      'text',
    content:   `Hi! I'm <strong>${agentName}</strong>, your AI tutor for <strong>${lectureTitle}</strong>. Ask me anything covered in this lecture!`,
    timestamp: new Date(0),
  };

  const dbMessages: ChatMessage[] = (historyData?.chatHistory ?? []).flatMap(
    (entry: HistoryEntry): ChatMessage[] => [
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
    ]
  );

  // In new-session mode, hide DB history from view but keep it available for the AI (via backend history loading)
  const messages: ChatMessage[] = [welcomeMsg, ...(isNewSession ? [] : dbMessages), ...localMessages];

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim()) return;

      // Cancel any in-progress typewriter animation from a previous message
      if (streamTimerRef.current) {
        clearInterval(streamTimerRef.current);
        streamTimerRef.current = null;
      }

      const userMsg: ChatMessage = {
        id: uuidv4(), role: 'user', type: 'text', content, timestamp: new Date(),
      };
      setLocalMessages(prev => [...prev, userMsg]);
      setTyping(true);
      console.log(`[CHAT] 📤 Sending to lecture #${lectureId}: "${content.slice(0, 60)}..."`);

      try {
        const { data } = await askLectureAgent({
          variables: { input: { lectureId, question: content } },
        });

        const response  = data?.askLectureAgent;
        const rawAnswer = response?.answer ?? FALLBACK_REPLY;
        const sources: ChunkSource[] = response?.sources ?? [];
        const citation = sources.length > 0 && sources[0].startTime
          ? `Lecture content · ${sources[0].startTime}`
          : 'Lecture content';

        // Strip HTML to get plain words for the animation; full HTML renders when done
        const words = rawAnswer.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
        const msgId = uuidv4();

        // Add placeholder — streaming begins, typing indicator stops simultaneously
        setLocalMessages(prev => [...prev, {
          id: msgId, role: 'ai', type: 'text',
          content: '', citation, sources, timestamp: new Date(),
          isStreaming: true,
        }]);
        setTyping(false);

        // Auto-speak starts at the same time as text streaming (teacher speaks while text appears)
        if (autoSpeakRef.current || voiceModeRef.current === 'voice') {
          voiceSpeakRef.current(rawAnswer);
        }

        // Reveal one word every 35 ms
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
            // Swap plain text for the full formatted HTML and mark stream done
            setLocalMessages(prev =>
              prev.map(m => m.id === msgId ? { ...m, content: rawAnswer, isStreaming: false } : m)
            );
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

  const clearChat = useCallback(async () => {
    try {
      await clearChatMutation({ variables: { lectureId } });
      setLocalMessages([]);
      setIsNewSession(false);
      await refetchHistory();
      console.log(`[CHAT] ✅ Chat cleared for lecture #${lectureId}`);
    } catch (err) {
      console.error('[CHAT] ❌ Clear chat failed:', err);
    }
  }, [lectureId, clearChatMutation, refetchHistory]);

  // Starts a fresh visual session without deleting DB history.
  // The AI backend still has full context from prior turns.
  const startNewSession = useCallback(() => {
    setLocalMessages([]);
    setIsNewSession(true);
    console.log(`[CHAT] 🆕 New session started for lecture #${lectureId}`);
  }, [lectureId]);

  const voice = useVoice({ onTranscript: sendMessage, enabled: mode === 'voice' });

  // Keep refs in sync with current state/voice so sendMessage can read them
  // without capturing them as useCallback deps (which would re-create it too often)
  autoSpeakRef.current  = autoSpeak;
  voiceModeRef.current  = mode;
  voiceSpeakRef.current = voice.speak;

  // Cancel stream on unmount (e.g., navigating away mid-stream)
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

  const toggleChat = useCallback(() => setOpen((o) => !o), []);

  return {
    messages,
    isTyping,
    isOpen,
    isLoadingHistory: historyLoading,
    isNewSession,
    historyEntries: (historyData?.chatHistory ?? []) as HistoryEntry[],
    mode,
    setMode,
    sendMessage,
    clearChat,
    startNewSession,
    toggleChat,
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
