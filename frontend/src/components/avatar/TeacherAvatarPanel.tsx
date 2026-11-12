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
// The portrait is now real footage of the presenter rather than a photo with
// drawn eyelids and a drawn mouth; PortraitAvatar is left in the codebase but
// no longer rendered.
const VideoAvatar = dynamic(() => import('./VideoAvatar'), { ssr: false });
const AvatarCanvas = dynamic(() => import('./AvatarCanvas'), {
  ssr: false,
  loading: () => <div className="w-full h-full flex items-center justify-center text-[12px] text-[var(--muted2)]">Loading 3D engine…</div>,
});

const STATUS_LABEL: Record<AvatarState, { text: string; cls: string }> = {
  IDLE:      { text: 'Ready',      cls: 'bg-[var(--surface)] text-[var(--muted)]' },
  LISTENING: { text: 'Listening',  cls: 'bg-emerald-50 text-emerald-700' },
  THINKING:  { text: 'Thinking…',  cls: 'bg-[var(--gold-soft)] text-[var(--gold)]' },
  SPEAKING:  { text: 'Speaking',   cls: 'bg-[var(--accent-soft)] text-[var(--accent-deep)]' },
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
    className={`w-9 h-9 rounded-card flex items-center justify-center text-[13px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
      active ? 'bg-[var(--accent)] text-white' : 'bg-[var(--surface)] text-[var(--muted)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)]'}`}
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
      IDLE: 'bg-slate-400', LISTENING: 'bg-emerald-500', THINKING: 'bg-[var(--gold)]', SPEAKING: 'bg-[var(--accent)]', ERROR: 'bg-red-500',
    };
    const CBtn = ({ title, onClick, disabled, active, children }: { title: string; onClick: () => void; disabled?: boolean; active?: boolean; children: React.ReactNode }) => (
      <button
        type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled}
        className={`w-7 h-7 rounded-full flex items-center justify-center transition-colors disabled:opacity-35 disabled:cursor-not-allowed ${
          active ? 'bg-[var(--accent)] text-white hover:bg-[var(--accent-deep)]' : 'text-[var(--muted)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)]'}`}
      >{children}</button>
    );
    return (
      <section
        aria-label="AI teacher avatar"
        data-avatar-mode={portrait ? 'portrait' : 'vrm'}
        data-avatar-status={portrait ? (showPortrait ? load.status : 'fallback') : webgl === null ? 'pending' : use3d ? load.status : 'fallback'}
        data-avatar-state={p.state}
        // Flat surface instead of a blue-to-white gradient: the gradient was
        // the only one in the product, and it made this strip read as a
        // separate widget rather than the top of the chat column.
        className="relative shrink-0 border-b border-[var(--border)] bg-[var(--surface)]"
      >
        <button type="button" onClick={p.onHide} title="Hide avatar" aria-label="Hide avatar"
          className="absolute top-2 right-3 z-10 w-7 h-7 rounded-full flex items-center justify-center text-[var(--muted2)] hover:text-[var(--accent)] hover:bg-[var(--accent-soft)]">
          <i className="fas fa-chevron-up text-[11px]" />
        </button>

        <div className="flex flex-col items-center pt-3">
          {/* Stage: the portrait, centred. Height is just the circle plus the
              room the pill needs to overlap it — the old box was 40px taller
              than its contents, which is where the empty space came from. */}
          <div className="relative w-[168px] h-[96px]">
            <div className={`absolute left-1/2 -translate-x-1/2 top-0 w-[96px] h-[96px] rounded-full bg-white ring-1 ring-[var(--border)] transition-shadow duration-300 ${
              // A quiet ring at rest; the accent only appears while speaking,
              // so the glow means something instead of decorating.
              speakingNow ? 'shadow-[0_0_0_3px_rgba(31,58,95,0.30)]' : ''}`} />
            <div className="absolute inset-0">
              {showPortrait ? (
                <div className="absolute left-1/2 -translate-x-1/2 top-0 w-[96px] h-[96px] rounded-full overflow-hidden">
                  <VideoAvatar state={p.state} />
                </div>
              ) : use3d ? (
                <AvatarCanvas url={stableUrl} state={p.state} getMouth={p.getMouth}
                  onStatus={(status, detail) => setLoad({ status, detail })} onProgress={setProgress} />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center gap-2 px-3 text-center">
                  <div className={`w-20 h-20 rounded-full overflow-hidden ring-4 ${speakingNow ? 'ring-[var(--accent)] animate-pulse' : 'ring-slate-200'}`}>
                    <Image src="/agent-avatar.png" alt={p.agentName} width={80} height={80} className="object-cover w-full h-full" />
                  </div>
                  <p className="text-[11px] text-[var(--muted)] leading-snug">
                    {webgl === false ? '3D view is not available in this browser.' : load.status === 'error' ? `3D avatar could not load. ${load.detail ?? ''}` : 'Preparing…'}
                  </p>
                </div>
              )}
              {/* 3D canvas only. The video portrait never reports loading, so
                  including it here left this ring spinning over the tutor's
                  face for as long as the page stayed open. */}
              {use3d && load.status === 'loading' && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                </div>
              )}
            </div>
          </div>

          {/* Name + status + controls: one floating pill that overlaps the bust's cut-off edge */}
          {/* Sits below the portrait with a gap, not on top of it: the overlap
              cut into the shoulders and read as two things colliding. */}
          <div className="relative mt-2.5 mb-3 flex items-center gap-1 bg-white rounded-full border border-[var(--border)] pl-3.5 pr-1.5 py-1">
            <span className="text-[14px] font-bold text-[var(--text)]">AI teacher</span>
            {/* Speaking shows moving bars, the shape every audio player uses
                for sound coming out. Thinking keeps a pulsing dot, because
                nothing is being heard yet, and anything else is a still dot.
                A single dot for all three said almost nothing. */}
            <span role="status" className="ml-1.5 inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--muted)]">
              {p.state === 'SPEAKING' && !p.isPaused ? (
                <span className="inline-flex items-end gap-[2px] h-[11px]" aria-hidden="true">
                  <span className="waveform-bar w-[2px] h-full rounded-full bg-[var(--accent)]" />
                  <span className="waveform-bar w-[2px] h-full rounded-full bg-[var(--accent)]" />
                  <span className="waveform-bar w-[2px] h-full rounded-full bg-[var(--accent)]" />
                </span>
              ) : (
                <span className={`w-2 h-2 rounded-full ${dot[p.state]} ${p.state === 'THINKING' ? 'animate-pulse' : ''}`} />
              )}
              {p.isPaused ? 'Paused' : label.text}
            </span>
            <span className="w-px h-5 bg-[var(--border)] mx-1.5" />
            {/* None of these is "on", so none is filled. The filled circle made
                play look like a different, larger control than stop beside it. */}
            {p.isPaused ? (
              <CBtn title="Resume" onClick={p.onResume}><i className="fas fa-play text-[11px]" /></CBtn>
            ) : speakingNow ? (
              <CBtn title="Pause" onClick={p.onPause}><i className="fas fa-pause text-[11px]" /></CBtn>
            ) : (
              <CBtn title={p.canReplay ? 'Play last answer' : 'Nothing to play yet'} onClick={p.onPlay} disabled={!p.speechSupported || !p.canReplay}>
                <i className="fas fa-play text-[11px]" />
              </CBtn>
            )}
            <CBtn title="Stop" onClick={p.onStop} disabled={!(speakingNow || p.isPaused)}><i className="fas fa-stop text-[11px]" /></CBtn>
            <CBtn title={p.muted ? 'Unmute' : 'Mute'} onClick={p.onToggleMute} active={p.muted}>
              <i className={`fas ${p.muted ? 'fa-volume-xmark' : 'fa-volume-high'} text-[11px]`} />
            </CBtn>
          </div>
          {!p.speechSupported && (
            <p className="-mt-1 mb-2 text-[12px] text-[var(--gold)]">Speech is not supported in this browser — answers stay available as text.</p>
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
      className={`bg-white overflow-hidden flex ${p.compact ? 'border-b border-[var(--border)] shrink-0' : 'mb-4 rounded-card border border-[var(--border)] shadow-sm'}`}
    >
      {/* Stage */}
      <div className={`relative shrink-0 bg-gradient-to-b from-[var(--accent-soft)] via-white to-[var(--accent-soft)] ${p.compact ? (portrait ? 'w-[118px] h-[136px]' : 'w-[110px] h-[136px]') : (portrait ? 'w-[230px] h-[290px]' : 'w-[210px] h-[250px]')}`}>
        {showPortrait ? (
          <VideoAvatar state={p.state} />
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
            <div className={`w-24 h-24 rounded-full overflow-hidden ring-4 ${speakingNow ? 'ring-[var(--accent)] animate-pulse' : 'ring-slate-200'}`}>
              <Image src="/agent-avatar.png" alt={p.agentName} width={96} height={96} className="object-cover w-full h-full" />
            </div>
            <p className="text-[11px] text-[var(--muted)] leading-snug">
              {webgl === false ? '3D view is not available in this browser.' : load.status === 'error' ? `3D avatar could not load. ${load.detail ?? ''}` : 'Preparing…'}
            </p>
          </div>
        )}
        {/* Same as above: this spinner belongs to the 3D canvas only. */}
        {use3d && load.status === 'loading' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white/70">
            <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
            <span className="text-[11px] text-[var(--muted)]">Loading teacher… {!portrait && progress > 0 ? `${Math.round(progress * 100)}%` : ''}</span>
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
            className="text-[11px] font-semibold text-[var(--muted)] hover:text-[var(--accent)] px-2 py-1 rounded-control hover:bg-[var(--accent-soft)]">
            Hide
          </button>
        </div>

        <div className={`${p.compact ? 'mt-1' : 'mt-2'} flex items-center gap-2`}>
          <span role="status" className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-semibold ${label.cls}`}>
            <span className={`w-1.5 h-1.5 rounded-full bg-current ${p.state === 'SPEAKING' || p.state === 'THINKING' ? 'animate-pulse' : ''}`} />
            {p.isPaused ? 'Paused' : label.text}
          </span>
          {p.muted && <span className="text-[11px] text-[var(--muted2)]">muted</span>}
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
          <p className="mt-2 text-[12px] text-[var(--gold)]">Speech is not supported in this browser — answers stay available as text.</p>
        )}
        {p.errorMessage && (
          <p role="alert" className="mt-2 text-[12px] text-red-600">{p.errorMessage}</p>
        )}
        <p
          className={`mt-auto text-[var(--muted2)] ${p.compact ? 'pt-1 text-[10px] leading-tight truncate' : 'pt-2 text-[10.5px] leading-snug'}`}
          title="Speaks the final answer with your browser's voice. Lip movement is approximate (derived from the text), not phoneme-exact."
        >
          {p.compact ? 'Browser voice · approximate lip movement' : 'Speaks the final answer with your browser\'s voice. Lip movement is approximate (derived from the text), not phoneme-exact.'}
        </p>
      </div>
    </section>
  );
}

export default TeacherAvatarPanel;
