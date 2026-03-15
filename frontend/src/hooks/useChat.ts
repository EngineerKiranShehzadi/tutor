'use client';
import { useState, useCallback, useRef, useEffect } from 'react';
import { ChatMessage } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import { useVoice } from './useVoice';

const MOCK_REPLIES = [
  'Based on this lecture, a zero-shot prompt gives the AI a task without any examples. The instructor emphasized this works best for well-defined, simple tasks.',
  'As covered here, the key to accurate prompts is being specific about the <strong>output format</strong>. Instead of "list ideas", say "list 5 ideas in bullet points".',
  'The lecture explains that prompt length matters — too short means vague results, too long can confuse the model. One clear instruction with just enough context is ideal.',
  'Great question! The instructor demonstrated at the 20-minute mark that a fast prompt avoids redundant context the model already knows from training.',
];

export const useChat = (lectureTitle: string) => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id:        uuidv4(),
      role:      'ai',
      type:      'text',
      content:   `Hi! I've processed this lecture on <strong>${lectureTitle}</strong>. Ask me anything covered in it — I'll only answer from this lecture's content.`,
      timestamp: new Date(),
    },
  ]);
  const [isTyping, setTyping] = useState(false);
  const [isOpen,   setOpen]   = useState(false);
  const [mode,     setMode]   = useState<'text' | 'voice'>('text');
  const replyIdxRef  = useRef(0);
  const prevCountRef = useRef(1); // start at 1 (welcome message)

  const sendMessage = useCallback((content: string) => {
    if (!content.trim()) return;
    const userMsg: ChatMessage = {
      id: uuidv4(), role: 'user', type: 'text', content, timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setTyping(true);

    setTimeout(() => {
      const reply = MOCK_REPLIES[replyIdxRef.current % MOCK_REPLIES.length];
      replyIdxRef.current++;
      const aiMsg: ChatMessage = {
        id:        uuidv4(),
        role:      'ai',
        type:      'text',
        content:   reply,
        citation:  'Sourced from this lecture',
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, aiMsg]);
      setTyping(false);
    }, 1600);
  }, []);

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
