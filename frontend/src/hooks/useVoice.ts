'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { stripHtml, getBestVoice, toChunks } from '@/lib/tts-utils';

export type VoiceStatus = 'idle' | 'listening' | 'speaking';

/**
 * Why listening stopped, in words a student can act on.
 *
 * Every one of these used to be discarded by `onerror`, so a refused
 * microphone, a missing microphone and a failed network call all looked
 * identical: the indicator showed "Listening", then stopped by itself a few
 * seconds later with nothing captured and nothing said.
 *
 * Worth knowing: Chrome's speech recognition is not local. It streams the
 * audio to Google's servers, so it needs a working internet connection and
 * reports 'network' when it cannot reach them.
 */
const VOICE_ERRORS: Record<string, string> = {
  'not-allowed':         'Microphone access is blocked. Allow it from the camera/microphone icon in the address bar, then try again.',
  'service-not-allowed': 'Microphone access is blocked by your browser or system settings.',
  'audio-capture':       'No microphone was found, or another app is using it. Check which input device is selected in your sound settings.',
  'network':             'Voice input needs an internet connection and could not reach the speech service.',
  'no-speech':           'Nothing was heard. Check that the correct microphone is selected and that it is not muted.',
  'language-not-supported': 'This browser does not support English speech recognition.',
};

interface UseVoiceProps {
  // Called when recognition stops — populates the input field, does NOT submit
  onTranscriptReady: (text: string) => void;
  enabled: boolean;
}

export const useVoice = ({ onTranscriptReady, enabled }: UseVoiceProps) => {
  const [status,      setStatus]      = useState<VoiceStatus>('idle');
  const [interimText, setInterimText] = useState('');
  const [isSupported, setIsSupported] = useState({ stt: false, tts: false });
  const [error,       setError]       = useState<string | null>(null);

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

  const stopListening = useCallback((deliver = false) => {
    clearSilence();
    const heard = finalRef.current.trim();
    if (recognitionRef.current) { recognitionRef.current.stop(); recognitionRef.current = null; }
    setStatus('idle');
    setInterimText('');
    finalRef.current = '';
    // Only when something was actually heard: an empty hand-over would wipe a
    // question the student had already typed or dictated and not yet sent.
    if (deliver && heard) onTranscriptReadyRef.current(heard);
  }, []);

  const startListening = useCallback(() => {
    if (!isSupported.stt) return;
    // Cancel any ongoing speech first
    window.speechSynthesis?.cancel();
    setStatus('idle');
    setError(null);

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

    rec.onerror = (e: any) => {
      const code = String(e?.error ?? 'unknown');
      if (code !== 'aborted') {
        setError(VOICE_ERRORS[code] ?? `Voice input stopped unexpectedly (${code}).`);
      }
      if (code !== 'no-speech') stopListening();
    };
    rec.onend = () => {
      if (!recognitionRef.current) return;
      // Recognition ended on its own. If it never heard a word and nothing has
      // been reported, that silence is itself the thing worth saying.
      if (!finalRef.current.trim()) {
        setError(prev => prev ?? VOICE_ERRORS['no-speech']);
      }
      setStatus('idle');
      setInterimText('');
    };

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
    // deliver = true: pressing stop means "I have finished saying it", so the
    // sentence goes into the box straight away instead of waiting on, or being
    // thrown away by, the silence timer.
    if (statusRef.current === 'listening') stopListening(true);
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
    error,
    clearError: () => setError(null),
    isListening:     status === 'listening',
    isSpeaking:      status === 'speaking',
    startListening,
    stopListening,
    toggleListening,
    speak,
    stopSpeaking,
  };
};
