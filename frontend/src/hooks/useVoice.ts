'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { stripHtml, getBestVoice, toChunks } from '@/lib/tts-utils';

export type VoiceStatus = 'idle' | 'listening' | 'speaking';

interface UseVoiceProps {
  // Called when recognition stops — populates the input field, does NOT submit
  onTranscriptReady: (text: string) => void;
  enabled: boolean;
}

export const useVoice = ({ onTranscriptReady, enabled }: UseVoiceProps) => {
  const [status,      setStatus]      = useState<VoiceStatus>('idle');
  const [interimText, setInterimText] = useState('');
  const [isSupported, setIsSupported] = useState({ stt: false, tts: false });

  const recognitionRef       = useRef<any>(null);
  const silenceTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalRef             = useRef('');
  const onTranscriptReadyRef = useRef(onTranscriptReady);
  const statusRef            = useRef<VoiceStatus>('idle');

  useEffect(() => { onTranscriptReadyRef.current = onTranscriptReady; }, [onTranscriptReady]);
  useEffect(() => { statusRef.current = status; }, [status]);

  useEffect(() => {
    setIsSupported({
      stt: !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition),
      tts: 'speechSynthesis' in window,
    });
  }, []);

  const clearSilence = () => {
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
  };

  const stopListening = useCallback(() => {
    clearSilence();
    if (recognitionRef.current) { recognitionRef.current.stop(); recognitionRef.current = null; }
    setStatus('idle');
    setInterimText('');
    finalRef.current = '';
  }, []);

  const startListening = useCallback(() => {
    if (!isSupported.stt) return;
    // Cancel any ongoing speech first
    window.speechSynthesis?.cancel();
    setStatus('idle');

    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec = new SR();
    rec.continuous     = true;
    rec.interimResults = true;
    rec.lang           = 'en-US';

    finalRef.current    = '';
    recognitionRef.current = rec;

    rec.onstart = () => setStatus('listening');

    rec.onresult = (e: any) => {
      let final = '';
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t + ' ';
        else interim += t;
      }
      if (final) finalRef.current += final;
      setInterimText(finalRef.current + interim);

      // After 1.5 s of silence: stop recording and put transcript into input field.
      // The user must press Enter or click Send to submit — no auto-submit.
      clearSilence();
      silenceTimerRef.current = setTimeout(() => {
        const text = finalRef.current.trim();
        if (text) { stopListening(); onTranscriptReadyRef.current(text); }
      }, 1500);
    };

    rec.onerror = (e: any) => { if (e.error !== 'no-speech') stopListening(); };
    rec.onend   = () => { if (recognitionRef.current) { setStatus('idle'); setInterimText(''); } };

    rec.start();
  }, [isSupported.stt, stopListening]);

  const speak = useCallback((text: string) => {
    if (!isSupported.tts) return;
    window.speechSynthesis.cancel();

    const clean = stripHtml(text).trim();
    if (!clean) return;

    const doSpeak = () => {
      const voice  = getBestVoice();
      const chunks = toChunks(clean);

      const speakAt = (idx: number) => {
        if (idx >= chunks.length) { setStatus('idle'); return; }
        const { text, pause } = chunks[idx];
        const utter   = new SpeechSynthesisUtterance(text);
        utter.lang    = 'en-IN';
        utter.rate    = 0.85;
        utter.pitch   = 1.0;
        utter.volume  = 1.0;
        if (voice) utter.voice = voice;
        if (idx === 0) utter.onstart = () => setStatus('speaking');
        utter.onend   = () => setTimeout(() => speakAt(idx + 1), pause);
        utter.onerror = () => setStatus('idle');
        window.speechSynthesis.speak(utter);
      };

      speakAt(0);
    };

    if (window.speechSynthesis.getVoices().length === 0) {
      window.speechSynthesis.addEventListener('voiceschanged', doSpeak, { once: true });
    } else {
      doSpeak();
    }
  }, [isSupported.tts]);

  const stopSpeaking = useCallback(() => {
    window.speechSynthesis?.cancel();
    setStatus('idle');
  }, []);

  const toggleListening = useCallback(() => {
    if (statusRef.current === 'listening') stopListening();
    else startListening();
  }, [startListening, stopListening]);

  // Stop everything when disabled (mode switched away from voice)
  useEffect(() => {
    if (!enabled) { stopListening(); stopSpeaking(); }
  }, [enabled, stopListening, stopSpeaking]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearSilence();
      recognitionRef.current?.stop();
      window.speechSynthesis?.cancel();
    };
  }, []);

  return {
    status,
    interimText,
    isSupported,
    isListening:     status === 'listening',
    isSpeaking:      status === 'speaking',
    startListening,
    stopListening,
    toggleListening,
    speak,
    stopSpeaking,
  };
};
