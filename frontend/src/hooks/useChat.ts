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
  const [isTyping,  setTyping]  = useState(false);
  const [isOpen,    setOpen]    = useState(false);
  const [mode,      setMode]    = useState<'text' | 'voice'>('text');
  const prevCountRef = useRef(0);

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
        citation:  entry.sources?.[0]?.topic
          ? `${entry.sources[0].topic}${entry.sources[0].startTime ? ' · ' + entry.sources[0].startTime : ''}`
          : 'Lecture content',
        timestamp: new Date(entry.createdAt),
      },
    ]
  );

  const messages: ChatMessage[] = [welcomeMsg, ...dbMessages, ...localMessages];

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim()) return;

      const userMsg: ChatMessage = {
        id: uuidv4(), role: 'user', type: 'text', content, timestamp: new Date(),
      };
      setLocalMessages((prev) => [...prev, userMsg]);
      setTyping(true);
      console.log(`[CHAT] 📤 Sending to lecture #${lectureId}: "${content.slice(0, 60)}..."`);

      try {
        const { data } = await askLectureAgent({
          variables: { input: { lectureId, question: content } },
        });

        const response = data?.askLectureAgent;
        const sources: ChunkSource[] = response?.sources ?? [];
        const citation = sources.length > 0
          ? `${sources[0].topic ?? 'Lecture content'}${sources[0].startTime ? ' · ' + sources[0].startTime : ''}`
          : 'Lecture content';

        const aiMsg: ChatMessage = {
          id:        uuidv4(),
          role:      'ai',
          type:      'text',
          content:   response?.answer ?? FALLBACK_REPLY,
          citation,
          sources,
          timestamp: new Date(),
        };
        setLocalMessages((prev) => [...prev, aiMsg]);
        console.log(`[CHAT] ✅ Answer received (${response?.answer?.length ?? 0} chars)`);
      } catch (err) {
        console.error('[CHAT] ❌ Error:', err);
        setLocalMessages((prev) => [...prev, {
          id: uuidv4(), role: 'ai', type: 'text', content: FALLBACK_REPLY, timestamp: new Date(),
        }]);
      } finally {
        setTyping(false);
      }
    },
    [lectureId, askLectureAgent]
  );

  const clearChat = useCallback(async () => {
    try {
      await clearChatMutation({ variables: { lectureId } });
      setLocalMessages([]);
      await refetchHistory();
      console.log(`[CHAT] ✅ Chat cleared for lecture #${lectureId}`);
    } catch (err) {
      console.error('[CHAT] ❌ Clear chat failed:', err);
    }
  }, [lectureId, clearChatMutation, refetchHistory]);

  const voice = useVoice({ onTranscript: sendMessage, enabled: mode === 'voice' });

  useEffect(() => {
    if (mode !== 'voice') return;
    if (messages.length <= prevCountRef.current) { prevCountRef.current = messages.length; return; }
    prevCountRef.current = messages.length;
    const last = messages[messages.length - 1];
    if (last?.role === 'ai') voice.speak(last.content);
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleChat = useCallback(() => setOpen((o) => !o), []);

  return {
    messages,
    isTyping,
    isOpen,
    isLoadingHistory: historyLoading,
    mode,
    setMode,
    sendMessage,
    clearChat,
    toggleChat,
    agentName,
    isRecording:       voice.isListening,
    isSpeaking:        voice.isSpeaking,
    interimText:       voice.interimText,
    toggleRecording:   voice.toggleListening,
    speak:             voice.speak,
    stopSpeaking:      voice.stopSpeaking,
    isSpeechSupported: voice.isSupported.stt,
  };
};
