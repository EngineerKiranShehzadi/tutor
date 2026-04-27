'use client';
import { useState, useCallback, useRef, useEffect } from 'react';
import { useMutation } from '@apollo/client';
import { ChatMessage } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import { useVoice } from './useVoice';
import { SEND_CHAT_MESSAGE_MUTATION } from '@/graphql/chat.mutations';

const FALLBACK_REPLY =
  "I'm having trouble connecting to the AI right now. Please try again in a moment.";

export const useChat = (lectureTitle: string, lectureId: string, agentName: string) => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id:        uuidv4(),
      role:      'ai',
      type:      'text',
      content:   `Hi! I'm <strong>${agentName}</strong>, your tutor for <strong>${lectureTitle}</strong>. Ask me anything covered in this lecture — I'll only answer from its content.`,
      timestamp: new Date(),
    },
  ]);
  const [isTyping,  setTyping] = useState(false);
  const [isOpen,    setOpen]   = useState(false);
  const [mode,      setMode]   = useState<'text' | 'voice'>('text');
  const prevCountRef = useRef(1);

  const [sendChatMessage] = useMutation(SEND_CHAT_MESSAGE_MUTATION);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim()) return;

      const userMsg: ChatMessage = {
        id: uuidv4(), role: 'user', type: 'text', content, timestamp: new Date(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setTyping(true);

      try {
        const { data } = await sendChatMessage({
          variables: { input: { lectureId, message: content } },
        });

        const response = data?.sendChatMessage;
        const citation =
          response?.sources?.length > 0
            ? `${response.agentName ?? agentName} · ${response.sources[0].title}`
            : `${response?.agentName ?? agentName} · lecture content`;

        const aiMsg: ChatMessage = {
          id:        uuidv4(),
          role:      'ai',
          type:      'text',
          content:   response?.explanation ?? FALLBACK_REPLY,
          citation,
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, aiMsg]);
      } catch {
        const aiMsg: ChatMessage = {
          id:        uuidv4(),
          role:      'ai',
          type:      'text',
          content:   FALLBACK_REPLY,
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, aiMsg]);
      } finally {
        setTyping(false);
      }
    },
    [lectureId, agentName, sendChatMessage]
  );

  const voice = useVoice({
    onTranscript: sendMessage,
    enabled:      mode === 'voice',
  });

  // Auto-speak new AI messages when in voice mode
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
    mode,
    setMode,
    sendMessage,
    toggleChat,
    agentName, // expose so ChatDrawer can show it
    // Voice
    isRecording:       voice.isListening,
    isSpeaking:        voice.isSpeaking,
    interimText:       voice.interimText,
    toggleRecording:   voice.toggleListening,
    speak:             voice.speak,
    stopSpeaking:      voice.stopSpeaking,
    isSpeechSupported: voice.isSupported.stt,
  };
};
