'use client';
// React glue around SpeechController: one TTS engine for the avatar.
// Re-renders only on speech state changes; the per-frame mouth shape is read
// through getMouth() by the render loop and never goes through React state.
import { useCallback, useEffect, useRef, useState } from 'react';
import { SpeechController, SpeechSnapshot, createBrowserSpeechDeps } from '@/lib/avatar/speech-controller';
import { pickBestVoice } from '@/lib/tts-utils';
import { closedMouth, MouthWeights } from '@/lib/avatar/lip-sync';

const MUTE_KEY = 'askaitutor_avatar_muted';
const INITIAL: SpeechSnapshot = { state: 'idle', muted: false, error: null, waitingForAudio: false };

export const useAvatarSpeech = () => {
  const controllerRef = useRef<SpeechController | null>(null);
  const [snap, setSnap] = useState<SpeechSnapshot>(INITIAL);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    const deps = createBrowserSpeechDeps(pickBestVoice);
    if (!deps) return;
    const c = new SpeechController(deps);
    controllerRef.current = c;
    setSupported(true);
    const unsub = c.subscribe(setSnap);
    try { if (localStorage.getItem(MUTE_KEY) === 'true') c.setMuted(true); } catch { /* storage unavailable */ }
    // Some browsers load voices lazily; touching the list early lets them populate.
    try { window.speechSynthesis.getVoices(); } catch { /* ignore */ }
    return () => { unsub(); c.dispose(); controllerRef.current = null; };
  }, []);

  const speak    = useCallback((text: string) => controllerRef.current?.speak(text), []);
  const pause    = useCallback(() => controllerRef.current?.pause(), []);
  const resume   = useCallback(() => controllerRef.current?.resume(), []);
  const stop     = useCallback(() => controllerRef.current?.stop(), []);
  const replay   = useCallback(() => controllerRef.current?.replay(), []);
  const toggleMute = useCallback(() => {
    const c = controllerRef.current;
    if (!c) return;
    const next = !c.snapshot().muted;
    c.setMuted(next);
    try { localStorage.setItem(MUTE_KEY, String(next)); } catch { /* storage unavailable */ }
  }, []);
  const getMouth = useCallback((): MouthWeights => controllerRef.current?.getMouth() ?? closedMouth(), []);
  const hasSpoken = useCallback((): boolean => !!controllerRef.current?.lastSpokenText, []);

  return {
    supported,
    speechState: snap.state,
    isSpeaking: snap.state === 'speaking',
    isPaused: snap.state === 'paused',
    muted: snap.muted,
    error: snap.error,
    waitingForAudio: snap.waitingForAudio,
    speak, pause, resume, stop, replay, toggleMute, getMouth, hasSpoken,
  };
};
