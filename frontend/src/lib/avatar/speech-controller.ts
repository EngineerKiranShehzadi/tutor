// Single owner of avatar speech: plays one answer at a time through the
// browser's speechSynthesis (the TTS the app already uses), exposes
// play/pause/resume/stop/replay/mute, and provides the live mouth shape.
//
// Lip-sync honesty: speechSynthesis exposes no audio data or phoneme timing,
// so mouth shapes come from a text-derived viseme timeline (lip-sync.ts) that
// is paced by the utterance rate and re-aligned on word `boundary` events when
// the browser provides them. It is approximate, not phoneme-accurate.
//
// All browser/time dependencies are injected so the logic is unit-testable.

import { stripHtml, toChunks, Chunk } from '../tts-utils';
import { buildTimeline, sampleTimeline, timeForChar, closedMouth, MouthWeights, LipSyncTimeline } from './lip-sync';

export type SpeechState = 'idle' | 'speaking' | 'paused';

export interface UtteranceLike {
  text: string;
  lang: string;
  rate: number;
  pitch: number;
  volume: number;
  voice: unknown;
  onstart: ((e?: unknown) => void) | null;
  onend: ((e?: unknown) => void) | null;
  onerror: ((e?: { error?: string }) => void) | null;
  onboundary: ((e: { charIndex: number; name?: string }) => void) | null;
}

export interface SynthLike {
  speak(u: UtteranceLike): void;
  cancel(): void;
  pause(): void;
  resume(): void;
  getVoices(): { name: string; lang: string }[];
}

export interface SpeechDeps {
  synth: SynthLike;
  createUtterance: (text: string) => UtteranceLike;
  pickVoice: (voices: { name: string; lang: string }[]) => unknown;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface SpeechSnapshot {
  state: SpeechState;
  muted: boolean;
  error: string | null;
  /** true when a speak() was requested but the browser has not started audio yet (e.g. autoplay policy) */
  waitingForAudio: boolean;
}

const RATE = 0.85;                     // same pace as the existing useVoice implementation
const START_TIMEOUT_MS = 2500;         // no `start` within this => likely blocked by autoplay policy

const cleanForSpeech = (raw: string): string =>
  stripHtml(raw)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export class SpeechController {
  private state: SpeechState = 'idle';
  private muted = false;
  private error: string | null = null;
  private waitingForAudio = false;

  private token = 0;                         // bumped on every speak/stop: stale callbacks are ignored
  private chunks: Chunk[] = [];
  private chunkIndex = 0;
  private timeline: LipSyncTimeline | null = null;
  private chunkStartedAt = 0;
  private chunkClockRunning = false;         // false between chunks and before audio starts
  private pausedAt = 0;
  private pausedAccum = 0;
  private interChunkTimer: unknown = null;
  private startTimer: unknown = null;
  private pendingAdvance = false;            // a chunk ended while paused: advance on resume
  private lastText = '';
  private listeners = new Set<(s: SpeechSnapshot) => void>();
  readonly stats = { boundaryEvents: 0, chunksSpoken: 0 };

  constructor(private deps: SpeechDeps) {}

  // ── observation ───────────────────────────────────────────────────────
  subscribe(fn: (s: SpeechSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  snapshot(): SpeechSnapshot {
    return { state: this.state, muted: this.muted, error: this.error, waitingForAudio: this.waitingForAudio };
  }
  private emit(): void { const s = this.snapshot(); this.listeners.forEach(l => l(s)); }
  private setState(next: SpeechState): void {
    if (this.state !== next) { this.state = next; this.emit(); }
  }
  get lastSpokenText(): string { return this.lastText; }

  /** Live mouth shape for the render loop. Closed whenever not actively speaking. */
  getMouth(): MouthWeights {
    if (this.state !== 'speaking' || !this.timeline || !this.chunkClockRunning) return closedMouth();
    const elapsed = this.deps.now() - this.chunkStartedAt - this.pausedAccum;
    return sampleTimeline(this.timeline, elapsed);
  }

  // ── commands ──────────────────────────────────────────────────────────
  speak(raw: string): void {
    const text = cleanForSpeech(raw);
    this.halt();                                  // never two answers at once
    this.error = null;
    if (!text) { this.emit(); return; }
    this.lastText = raw;
    this.chunks = toChunks(text);
    this.chunkIndex = 0;
    this.pausedAccum = 0;
    this.pendingAdvance = false;
    this.waitingForAudio = true;
    this.setState('speaking');
    this.startChunk(this.token);
  }

  replay(): void {
    if (this.lastText) this.speak(this.lastText);
  }

  pause(): void {
    if (this.state !== 'speaking') return;
    this.pausedAt = this.deps.now();
    this.clearInterChunkTimer();
    this.deps.synth.pause();
    this.setState('paused');
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.pausedAccum += this.deps.now() - this.pausedAt;
    this.deps.synth.resume();
    this.setState('speaking');
    if (this.pendingAdvance) {                    // paused in the gap between chunks
      this.pendingAdvance = false;
      this.advance(this.token, 0);
    }
  }

  stop(): void {
    this.halt();
    this.waitingForAudio = false;
    this.setState('idle');
    this.emit();
  }

  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    // Volume cannot change mid-utterance in speechSynthesis: restart the current
    // short chunk (clause/sentence) so the change is audible immediately.
    if (this.state === 'speaking' && this.chunkClockRunning) {
      const t = ++this.token;
      this.deps.synth.cancel();
      this.chunkClockRunning = false;
      this.pausedAccum = 0;
      this.startChunk(t);
    }
    this.emit();
  }

  dispose(): void {
    this.halt();
    this.listeners.clear();
    this.state = 'idle';
  }

  // ── internals ─────────────────────────────────────────────────────────
  /** Cancels audio and timers and invalidates every pending callback. */
  private halt(): void {
    this.token++;
    this.clearInterChunkTimer();
    if (this.startTimer !== null) { this.deps.clearTimeout(this.startTimer); this.startTimer = null; }
    this.deps.synth.cancel();
    this.chunkClockRunning = false;
    this.timeline = null;
    this.pendingAdvance = false;
  }

  private clearInterChunkTimer(): void {
    if (this.interChunkTimer !== null) { this.deps.clearTimeout(this.interChunkTimer); this.interChunkTimer = null; }
  }

  private fail(token: number, message: string): void {
    if (token !== this.token) return;
    this.halt();
    this.waitingForAudio = false;
    this.error = message;
    this.state = 'idle';
    this.emit();
  }

  private startChunk(token: number): void {
    if (token !== this.token) return;
    const chunk = this.chunks[this.chunkIndex];
    if (!chunk) { this.finish(token); return; }

    const u = this.deps.createUtterance(chunk.text);
    u.lang = 'en-IN';
    u.rate = RATE;
    u.pitch = 1.0;
    u.volume = this.muted ? 0 : 1;
    const voice = this.deps.pickVoice(this.deps.synth.getVoices());
    if (voice) u.voice = voice;

    this.timeline = buildTimeline(chunk.text, RATE);

    u.onstart = () => {
      if (token !== this.token) return;
      this.chunkStartedAt = this.deps.now();
      this.chunkClockRunning = true;
      if (this.startTimer !== null) { this.deps.clearTimeout(this.startTimer); this.startTimer = null; }
      if (this.waitingForAudio) { this.waitingForAudio = false; this.emit(); }
    };
    // Re-align the approximate timeline to the real speech at each word boundary.
    u.onboundary = (e) => {
      if (token !== this.token || !this.timeline) return;
      this.stats.boundaryEvents++;
      const target = timeForChar(this.timeline, e.charIndex);
      this.chunkStartedAt = this.deps.now() - target - this.pausedAccum;
      this.chunkClockRunning = true;
    };
    u.onend = () => {
      if (token !== this.token) return;           // stale (cancelled / replaced / stopped)
      this.stats.chunksSpoken++;
      this.chunkClockRunning = false;
      this.pausedAccum = 0;
      this.chunkIndex++;
      this.advance(token, chunk.pause);
    };
    u.onerror = (e) => {
      if (token !== this.token) return;
      const code = e?.error;
      if (code === 'interrupted' || code === 'canceled') return;   // caused by our own cancel()
      this.fail(token, `Speech failed${code ? ` (${code})` : ''}`);
    };

    // If audio never starts (autoplay policy, no voices) tell the UI so it can
    // offer an explicit "play" action instead of silently showing "speaking".
    if (this.chunkIndex === 0) {
      if (this.startTimer !== null) this.deps.clearTimeout(this.startTimer);
      this.startTimer = this.deps.setTimeout(() => {
        if (token === this.token && this.waitingForAudio) {
          this.halt();
          this.waitingForAudio = true;
          this.state = 'idle';
          this.error = 'Audio did not start. Click Play to hear the answer.';
          this.emit();
        }
      }, START_TIMEOUT_MS);
    }

    this.deps.synth.speak(u);
  }

  private advance(token: number, pauseMs: number): void {
    if (token !== this.token) return;
    if (this.state === 'paused') { this.pendingAdvance = true; return; }
    if (this.chunkIndex >= this.chunks.length) { this.finish(token); return; }
    if (pauseMs <= 0) { this.startChunk(token); return; }
    this.interChunkTimer = this.deps.setTimeout(() => {
      this.interChunkTimer = null;
      if (this.state === 'paused') { this.pendingAdvance = true; return; }
      this.startChunk(token);
    }, pauseMs);
  }

  private finish(token: number): void {
    if (token !== this.token) return;
    this.chunkClockRunning = false;
    this.timeline = null;
    this.waitingForAudio = false;
    this.setState('idle');
    this.emit();
  }
}

/** Browser wiring. Returns null when speechSynthesis is unavailable. */
export const createBrowserSpeechDeps = (pickVoice: SpeechDeps['pickVoice']): SpeechDeps | null => {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  return {
    synth: window.speechSynthesis as unknown as SynthLike,
    createUtterance: (text) => new SpeechSynthesisUtterance(text) as unknown as UtteranceLike,
    pickVoice,
    now: () => performance.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => window.clearTimeout(h as number),
  };
};
