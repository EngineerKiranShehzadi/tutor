'use client';
// Standalone preview/QA page for the AI teacher avatar (no login, no backend):
//   /avatar-preview                      interactive demo (type text, press Speak)
//   /avatar-preview?state=speaking       force a pose state (idle|listening|thinking|speaking|error)
//   /avatar-preview?agent=Nova           show a specific agent name
// Useful for checking the 3D rendering, poses and controls in isolation.
import { useEffect, useMemo, useState } from 'react';
import { TeacherAvatarPanel } from '@/components/avatar/TeacherAvatarPanel';
import { useAvatarSpeech } from '@/hooks/useAvatarSpeech';
import { AvatarState, deriveAvatarState } from '@/lib/avatar/avatar-state';
import { MouthWeights } from '@/lib/avatar/lip-sync';

const SAMPLE = 'Efficient time management helps you complete more work in less time. Plan your day, then follow the schedule step by step.';
const STATES: AvatarState[] = ['IDLE', 'LISTENING', 'THINKING', 'SPEAKING', 'ERROR'];

export default function AvatarPreviewPage() {
  const speech = useAvatarSpeech();
  const [text, setText] = useState(SAMPLE);
  const [agent, setAgent] = useState('Nova');
  const [forced, setForced] = useState<AvatarState | null>(null);
  const [typing, setTyping] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const s = q.get('state')?.toUpperCase();
    if (s && (STATES as string[]).includes(s)) setForced(s as AvatarState);
    const a = q.get('agent');
    if (a) setAgent(a);
  }, []);

  const derived = deriveAvatarState({
    isAnswerPending: pending, isSpeaking: speech.isSpeaking, isUserInputActive: typing, hasError: false,
  });
  const state = forced ?? derived;

  // When a pose is forced for QA, drive the mouth with a synthetic open/close so SPEAKING is visible.
  const forcedMouth = useMemo(() => (): MouthWeights => {
    const t = performance.now() / 1000;
    const open = Math.max(0, Math.sin(t * 9)) * 0.8;
    return { aa: open, ih: 0, ou: 0, ee: 0, oh: open * 0.3 };
  }, []);

  return (
    <main className="max-w-[760px] mx-auto p-6">
      <h1 className="text-[20px] font-bold mb-1">AI teacher avatar — preview</h1>
      <p className="text-[13px] text-slate-500 mb-4">QA page. The real avatar appears on each lecture page next to the chat.</p>

      <TeacherAvatarPanel
        compact
        agentName={agent}
        lectureTitle="Preview lecture"
        state={state}
        getMouth={forced === 'SPEAKING' ? forcedMouth : speech.getMouth}
        speechSupported={speech.supported}
        isSpeaking={speech.isSpeaking}
        isPaused={speech.isPaused}
        muted={speech.muted}
        canReplay={speech.hasSpoken()}
        errorMessage={speech.error}
        onPlay={speech.replay}
        onPause={speech.pause}
        onResume={speech.resume}
        onStop={speech.stop}
        onToggleMute={speech.toggleMute}
        onHide={() => { /* preview page always shows the avatar */ }}
      />

      <label className="block text-[12px] font-semibold text-slate-600 mb-1">Text to speak</label>
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setTyping(e.target.value.length > 0); }}
        rows={4}
        className="w-full border border-slate-200 rounded-xl p-3 text-[14px]"
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-[13px] font-semibold" onClick={() => { setForced(null); speech.speak(text); }}>Speak</button>
        <button className="px-4 py-2 rounded-xl bg-slate-100 text-[13px] font-semibold" onClick={() => { setForced(null); setPending(true); setTimeout(() => setPending(false), 4000); }}>Simulate thinking (4s)</button>
        {STATES.map(s => (
          <button key={s} className={`px-3 py-2 rounded-xl text-[12px] font-semibold ${forced === s ? 'bg-indigo-600 text-white' : 'bg-slate-100'}`} onClick={() => setForced(forced === s ? null : s)}>{s}</button>
        ))}
      </div>
    </main>
  );
}
