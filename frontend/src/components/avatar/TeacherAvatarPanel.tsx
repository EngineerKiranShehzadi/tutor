'use client';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import { useEffect, useMemo, useState } from 'react';
import { AvatarState } from '@/lib/avatar/avatar-state';
import { MouthWeights } from '@/lib/avatar/lip-sync';
import { AVATAR_MODEL_URL, AVATAR_MODE } from '@/lib/avatar/config';
import { isWebGLAvailable } from '@/lib/avatar/webgl';
import type { AvatarLoadStatus } from './AvatarCanvas';

// Three.js / the VRM loader are only fetched when the panel is actually shown,
// and never during server rendering.
const PortraitAvatar = dynamic(() => import('./PortraitAvatar'), { ssr: false });
const AvatarCanvas = dynamic(() => import('./AvatarCanvas'), {
  ssr: false,
  loading: () => <div className="w-full h-full flex items-center justify-center text-[12px] text-slate-400">Loading 3D engine…</div>,
});

const STATUS_LABEL: Record<AvatarState, { text: string; cls: string }> = {
  IDLE:      { text: 'Ready',      cls: 'bg-slate-100 text-slate-600' },
  LISTENING: { text: 'Listening',  cls: 'bg-emerald-50 text-emerald-700' },
  THINKING:  { text: 'Thinking…',  cls: 'bg-amber-50 text-amber-700' },
  SPEAKING:  { text: 'Speaking',   cls: 'bg-indigo-50 text-indigo-700' },
  ERROR:     { text: 'Problem',    cls: 'bg-red-50 text-red-700' },
};

export interface TeacherAvatarPanelProps {
  agentName: string;
  lectureTitle: string;
  state: AvatarState;
  getMouth: () => MouthWeights;
  /** speech */
  speechSupported: boolean;
  isSpeaking: boolean;
  isPaused: boolean;
  muted: boolean;
  canReplay: boolean;
  errorMessage: string | null;
  onPlay: () => void;          // (re)play the last answer
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onToggleMute: () => void;
  onHide: () => void;
  modelUrl?: string;
  /** smaller stage + tighter spacing, for placement at the top of the chat column */
  compact?: boolean;
}

const Btn = ({ title, onClick, disabled, children, active }: { title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode; active?: boolean }) => (
  <button
    type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled}
    className={`w-9 h-9 rounded-xl flex items-center justify-center text-[13px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
      active ? 'bg-indigo-600 text-white' : 'bg-[var(--surface)] text-slate-600 hover:bg-indigo-50 hover:text-indigo-600'}`}
  >{children}</button>
);

export function TeacherAvatarPanel(p: TeacherAvatarPanelProps) {
  const [webgl, setWebgl] = useState<boolean | null>(null);       // null = not probed yet (SSR-safe)
  const [load, setLoad] = useState<{ status: AvatarLoadStatus; detail?: string }>({ status: 'loading' });
  const [progress, setProgress] = useState(0);
  useEffect(() => { setWebgl(isWebGLAvailable()); }, []);

  const label = STATUS_LABEL[p.state];
  const portrait = AVATAR_MODE === 'portrait';
  const use3d = !portrait && webgl === true && load.status !== 'error';
  const showPortrait = portrait && load.status !== 'error';
  const speakingNow = p.isSpeaking && !p.isPaused;
  const stableUrl = useMemo(() => p.modelUrl ?? AVATAR_MODEL_URL, [p.modelUrl]);

  if (p.compact) {
    const dot: Record<AvatarState, string> = {
      IDLE: 'bg-slate-400', LISTENING: 'bg-emerald-500', THINKING: 'bg-amber-500', SPEAKING: 'bg-indigo-500', ERROR: 'bg-red-500',
    };
    const CBtn = ({ title, onClick, disabled, active, children }: { title: string; onClick: () => void; disabled?: boolean; active?: boolean; children: React.ReactNode }) => (
      <button
        type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled}
        className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors disabled:opacity-35 disabled:cursor-not-allowed ${
          active ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'text-slate-600 hover:bg-indigo-50 hover:text-indigo-600'}`}
      >{children}</button>
    );
    return (
      <section
        aria-label="AI teacher avatar"
        data-avatar-mode={portrait ? 'portrait' : 'vrm'}
        data-avatar-status={portrait ? (showPortrait ? load.status : 'fallback') : webgl === null ? 'pending' : use3d ? load.status : 'fallback'}
        data-avatar-state={p.state}
        className="relative shrink-0 border-b border-[var(--border)] bg-gradient-to-b from-indigo-50 via-white to-white"
      >
        <button type="button" onClick={p.onHide} title="Hide avatar" aria-label="Hide avatar"
          className="absolute top-2 right-3 z-10 w-7 h-7 rounded-full flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:bg-indigo-50">
          <i className="fas fa-chevron-up text-[11px]" />
        </button>

        <div className="flex flex-col items-center pt-3">
          {/* Stage: spotlight halo behind the bust, centred */}
          <div className="relative w-[168px] h-[156px]">
            <div className={`absolute left-1/2 -translate-x-1/2 top-2 w-[116px] h-[116px] rounded-full bg-gradient-to-b from-indigo-100 to-purple-100 transition-shadow duration-300 ${
              speakingNow ? 'shadow-[0_0_0_6px_rgba(99,102,241,0.25),0_0_28px_6px_rgba(99,102,241,0.25)]' : 'shadow-[0_0_0_4px_rgba(99,102,241,0.08)]'}`} />
            <div className="absolute inset-0">
              {showPortrait ? (
                <PortraitAvatar
                  state={p.state}
                  getMouth={p.getMouth}
                  zoom={1}
                  transparent
                  onStatus={(status, detail) => setLoad({ status, detail })}
                />
              ) : use3d ? (
                <AvatarCanvas url={stableUrl} state={p.state} getMouth={p.getMouth}
                  onStatus={(status, detail) => setLoad({ status, detail })} onProgress={setProgress} />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center gap-2 px-3 text-center">
                  <div className={`w-20 h-20 rounded-full overflow-hidden ring-4 ${speakingNow ? 'ring-indigo-400 animate-pulse' : 'ring-slate-200'}`}>
                    <Image src="/agent-avatar.png" alt={p.agentName} width={80} height={80} className="object-cover w-full h-full" />
                  </div>
                  <p className="text-[11px] text-slate-500 leading-snug">
                    {webgl === false ? '3D view is not available in this browser.' : load.status === 'error' ? `3D avatar could not load. ${load.detail ?? ''}` : 'Preparing…'}
                  </p>
                </div>
              )}
              {(use3d || showPortrait) && load.status === 'loading' && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                </div>
              )}
            </div>
          </div>

          {/* Name + status + controls: one floating pill that overlaps the bust's cut-off edge */}
          <div className="relative -mt-5 mb-3 flex items-center gap-1 bg-white rounded-full shadow-md border border-[var(--border)] pl-3.5 pr-1.5 py-1">
            <span className="text-[14px] font-bold text-[var(--text)]">AI teacher</span>
            <span role="status" className="ml-1.5 inline-flex items-center gap-1.5 text-[12px] font-semibold text-slate-600">
              <span className={`w-2 h-2 rounded-full ${dot[p.state]} ${p.state === 'SPEAKING' || p.state === 'THINKING' ? 'animate-pulse' : ''}`} />
              {p.isPaused ? 'Paused' : label.text}
            </span>
            <span className="w-px h-5 bg-[var(--border)] mx-1.5" />
            {p.isPaused ? (
              <CBtn title="Resume" onClick={p.onResume} active><i className="fas fa-play text-[11px]" /></CBtn>
            ) : speakingNow ? (
              <CBtn title="Pause" onClick={p.onPause} active><i className="fas fa-pause text-[11px]" /></CBtn>
            ) : (
              <CBtn title={p.canReplay ? 'Play last answer' : 'Nothing to play yet'} onClick={p.onPlay} disabled={!p.speechSupported || !p.canReplay}>
                <i className="fas fa-play text-[11px]" />
              </CBtn>
            )}
            <CBtn title="Stop" onClick={p.onStop} disabled={!(speakingNow || p.isPaused)}><i className="fas fa-stop text-[11px]" /></CBtn>
            <CBtn title={p.muted ? 'Unmute' : 'Mute'} onClick={p.onToggleMute} active={p.muted}>
              <i className={`fas ${p.muted ? 'fa-volume-xmark' : 'fa-volume-high'} text-[12px]`} />
            </CBtn>
          </div>
          {!p.speechSupported && (
            <p className="-mt-1 mb-2 text-[12px] text-amber-700">Speech is not supported in this browser — answers stay available as text.</p>
          )}
          {p.errorMessage && (
            <p role="alert" className="-mt-1 mb-2 text-[12px] text-red-600">{p.errorMessage}</p>
          )}
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="AI teacher avatar"
      data-avatar-mode={portrait ? 'portrait' : 'vrm'}
      data-avatar-status={portrait ? (showPortrait ? load.status : 'fallback') : webgl === null ? 'pending' : use3d ? load.status : 'fallback'}
      data-avatar-state={p.state}
      className={`bg-white overflow-hidden flex ${p.compact ? 'border-b border-[var(--border)] shrink-0' : 'mb-4 rounded-xl border border-[var(--border)] shadow-sm'}`}
    >
      {/* Stage */}
      <div className={`relative shrink-0 bg-gradient-to-b from-indigo-50 via-white to-purple-50 ${p.compact ? (portrait ? 'w-[118px] h-[136px]' : 'w-[110px] h-[136px]') : (portrait ? 'w-[230px] h-[290px]' : 'w-[210px] h-[250px]')}`}>
        {showPortrait ? (
          <PortraitAvatar
            state={p.state}
            getMouth={p.getMouth}
            zoom={p.compact ? 1.5 : 1}
            onStatus={(status, detail) => setLoad({ status, detail })}
          />
        ) : use3d ? (
          <AvatarCanvas
            url={stableUrl}
            state={p.state}
            getMouth={p.getMouth}
            onStatus={(status, detail) => setLoad({ status, detail })}
            onProgress={setProgress}
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 px-3 text-center">
            <div className={`w-24 h-24 rounded-full overflow-hidden ring-4 ${speakingNow ? 'ring-indigo-400 animate-pulse' : 'ring-slate-200'}`}>
              <Image src="/agent-avatar.png" alt={p.agentName} width={96} height={96} className="object-cover w-full h-full" />
            </div>
            <p className="text-[11px] text-slate-500 leading-snug">
              {webgl === false ? '3D view is not available in this browser.' : load.status === 'error' ? `3D avatar could not load. ${load.detail ?? ''}` : 'Preparing…'}
            </p>
          </div>
        )}
        {(use3d || showPortrait) && load.status === 'loading' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white/70">
            <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
            <span className="text-[11px] text-slate-500">Loading teacher… {!portrait && progress > 0 ? `${Math.round(progress * 100)}%` : ''}</span>
          </div>
        )}
      </div>

      {/* Info + controls */}
      <div className={`flex-1 min-w-0 flex flex-col ${p.compact ? 'px-3 py-2' : 'p-4'}`}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-[16px] font-bold text-[var(--text)] leading-tight">{p.agentName}</p>
            <p className="text-[12px] text-[var(--muted)] truncate">AI teacher · {p.lectureTitle}</p>
          </div>
          <button type="button" onClick={p.onHide} title="Hide avatar" aria-label="Hide avatar"
            className="text-[11px] font-semibold text-slate-500 hover:text-indigo-600 px-2 py-1 rounded-lg hover:bg-indigo-50">
            Hide
          </button>
        </div>

        <div className={`${p.compact ? 'mt-1' : 'mt-2'} flex items-center gap-2`}>
          <span role="status" className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-semibold ${label.cls}`}>
            <span className={`w-1.5 h-1.5 rounded-full bg-current ${p.state === 'SPEAKING' || p.state === 'THINKING' ? 'animate-pulse' : ''}`} />
            {p.isPaused ? 'Paused' : label.text}
          </span>
          {p.muted && <span className="text-[11px] text-slate-400">muted</span>}
        </div>

        <div className={`${p.compact ? 'mt-2' : 'mt-3'} flex items-center gap-2`}>
          {p.isPaused ? (
            <Btn title="Resume" onClick={p.onResume} active><i className="fas fa-play text-[11px]" /></Btn>
          ) : speakingNow ? (
            <Btn title="Pause" onClick={p.onPause}><i className="fas fa-pause text-[11px]" /></Btn>
          ) : (
            <Btn title={p.canReplay ? 'Play last answer' : 'Nothing to play yet'} onClick={p.onPlay} disabled={!p.speechSupported || !p.canReplay} active>
              <i className="fas fa-play text-[11px]" />
            </Btn>
          )}
          <Btn title="Stop" onClick={p.onStop} disabled={!(speakingNow || p.isPaused)}><i className="fas fa-stop text-[11px]" /></Btn>
          <Btn title="Replay from the start" onClick={p.onPlay} disabled={!p.speechSupported || !p.canReplay}><i className="fas fa-rotate-left text-[11px]" /></Btn>
          <Btn title={p.muted ? 'Unmute' : 'Mute'} onClick={p.onToggleMute} active={p.muted}>
            <i className={`fas ${p.muted ? 'fa-volume-xmark' : 'fa-volume-high'} text-[12px]`} />
          </Btn>
        </div>

        {!p.speechSupported && (
          <p className="mt-2 text-[12px] text-amber-700">Speech is not supported in this browser — answers stay available as text.</p>
        )}
        {p.errorMessage && (
          <p role="alert" className="mt-2 text-[12px] text-red-600">{p.errorMessage}</p>
        )}
        <p
          className={`mt-auto text-slate-400 ${p.compact ? 'pt-1 text-[10px] leading-tight truncate' : 'pt-2 text-[10.5px] leading-snug'}`}
          title="Speaks the final answer with your browser's voice. Lip movement is approximate (derived from the text), not phoneme-exact."
        >
          {p.compact ? 'Browser voice · approximate lip movement' : 'Speaks the final answer with your browser\'s voice. Lip movement is approximate (derived from the text), not phoneme-exact.'}
        </p>
      </div>
    </section>
  );
}

export default TeacherAvatarPanel;
