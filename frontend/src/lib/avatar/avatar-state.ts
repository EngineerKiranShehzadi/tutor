// Avatar behaviour logic, free of React/Three so it can be unit-tested:
//  - deriveAvatarState(): which of IDLE / LISTENING / THINKING / SPEAKING /
//    ERROR the teacher is in, from the chat + speech status.
//  - AvatarPoseDriver: procedural body/face animation. Everything is expressed
//    as a *semantic* pose (arm lowered/forward/elbow, head pitch/yaw/roll,
//    expression weights); the renderer maps it onto VRM bones.
//
// All transitions go through damped blend weights, so changing state never
// produces a jump. Gestures are procedural and randomly scheduled during
// speech — they are NOT semantically matched to what is being said.

import { MouthSmoother, MouthWeights, closedMouth } from './lip-sync';
import { ARM_GESTURES_ENABLED } from './config';

export type AvatarState = 'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING' | 'ERROR';

export interface AvatarInputs {
  /** a chat request is in flight (question sent, final verified answer not yet received) */
  isAnswerPending: boolean;
  /** speech playing (not paused) */
  isSpeaking: boolean;
  /** the student is typing or dictating */
  isUserInputActive: boolean;
  /** a failure to surface (answer failed or speech failed) */
  hasError: boolean;
}

/** Priority: ERROR > SPEAKING > THINKING > LISTENING > IDLE. Paused speech counts as IDLE. */
export const deriveAvatarState = (i: AvatarInputs): AvatarState => {
  if (i.hasError) return 'ERROR';
  if (i.isSpeaking) return 'SPEAKING';
  if (i.isAnswerPending) return 'THINKING';
  if (i.isUserInputActive) return 'LISTENING';
  return 'IDLE';
};

// ── pose model ──────────────────────────────────────────────────────────

export interface ArmPose {
  /** upper arm lowered from the T-pose (rad) — ~1.2 is "hanging at the side" */
  down: number;
  /** swing forward (rad) */
  forward: number;
  /** elbow flexion (rad) */
  elbow: number;
  /** wrist/hand rotation (rad) */
  wrist: number;
}
export interface HeadPose { pitch: number; yaw: number; roll: number }
export interface Expressions {
  blink: number; happy: number; relaxed: number; lookUp: number;
}
export interface AvatarPose {
  spine: HeadPose;
  head: HeadPose;
  leftArm: ArmPose;
  rightArm: ArmPose;
  shoulderLift: number;
  expr: Expressions;
  mouth: MouthWeights;
}

// Hanging straight down along the body (T-pose arm rotated ~90 degrees), no elbow bend.
const REST_ARM: ArmPose = { down: 1.5, forward: 0, elbow: 0, wrist: 0 };

const mulberry32 = (seed: number) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

interface GestureDef {
  name: string;
  duration: number;                         // seconds
  right?: Partial<ArmPose>;                 // offsets added to the rest pose at full envelope
  left?: Partial<ArmPose>;
  head?: Partial<HeadPose>;
  pulses?: number;                          // emphasis beats inside the envelope
}

export const GESTURES: GestureDef[] = [
  { name: 'openHandRight', duration: 2.1, right: { down: -0.42, forward: 0.5, elbow: 0.7, wrist: 0.25 }, head: { pitch: -0.02, yaw: 0.04 } },
  { name: 'openHandsBoth', duration: 2.3, right: { down: -0.38, forward: 0.42, elbow: 0.75, wrist: 0.2 }, left: { down: -0.38, forward: 0.42, elbow: 0.75, wrist: 0.2 } },
  { name: 'emphasisRight', duration: 1.3, right: { down: -0.5, forward: 0.62, elbow: 0.95, wrist: 0.1 }, pulses: 2, head: { pitch: 0.05 } },
  { name: 'explainLeft',   duration: 1.9, left:  { down: -0.4, forward: 0.46, elbow: 0.8, wrist: 0.25 }, head: { yaw: -0.05 } },
  { name: 'nod',           duration: 0.9, head: { pitch: 0.1 } },
];

const damp = (cur: number, target: number, ratePerSec: number, dt: number) =>
  cur + (target - cur) * (1 - Math.exp(-ratePerSec * Math.max(0, dt)));

const env = (p: number) => Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, p))), 1.4);

export class AvatarPoseDriver {
  private t = 0;
  private rng: () => number;
  private blend = { speaking: 0, thinking: 0, listening: 0, error: 0 };
  private gesture: { def: GestureDef; startedAt: number } | null = null;
  private lastGesture = '';
  private nextGestureAt = 1.2;
  private blinkAt = 2.4;
  private blinkStart = -10;
  private blinkDur = 0.17;
  private mouth = new MouthSmoother();
  /** most recent gesture name, for tests/diagnostics */
  get currentGesture(): string | null { return this.gesture?.def.name ?? null; }

  constructor(seed = 20260101, private armGestures: boolean = ARM_GESTURES_ENABLED) {
    this.rng = mulberry32(seed);
  }

  /** Advance by dtSec. `mouthTarget` is the live viseme target from the speech controller. */
  update(dtSec: number, state: AvatarState, mouthTarget: MouthWeights = closedMouth()): AvatarPose {
    const dt = Math.min(Math.max(dtSec, 0), 0.1);   // clamp so a stalled tab cannot cause a jump
    this.t += dt;
    const t = this.t;

    // ── state blends (damped → smooth transitions) ──────────────────────
    const want = {
      speaking: state === 'SPEAKING' ? 1 : 0,
      thinking: state === 'THINKING' ? 1 : 0,
      listening: state === 'LISTENING' ? 1 : 0,
      error: state === 'ERROR' ? 1 : 0,
    };
    this.blend.speaking  = damp(this.blend.speaking,  want.speaking,  4.0, dt);
    this.blend.thinking  = damp(this.blend.thinking,  want.thinking,  3.0, dt);
    this.blend.listening = damp(this.blend.listening, want.listening, 3.0, dt);
    this.blend.error     = damp(this.blend.error,     want.error,     5.0, dt);
    const b = this.blend;

    // ── gestures (only while speaking) ──────────────────────────────────
    if (this.gesture && t - this.gesture.startedAt >= this.gesture.def.duration) {
      this.gesture = null;
      this.nextGestureAt = t + 0.9 + this.rng() * 2.4;
    }
    if (!this.gesture && state === 'SPEAKING' && b.speaking > 0.6 && t >= this.nextGestureAt) {
      // Arm gestures are opt-in; otherwise only head-only gestures (nods) are used.
      const eligible = this.armGestures ? GESTURES : GESTURES.filter(g => !g.left && !g.right);
      const fresh = eligible.filter(g => g.name !== this.lastGesture);   // never the same gesture twice in a row
      const pool = fresh.length > 0 ? fresh : eligible;                 // (only one eligible gesture: allow repeats)
      const def = pool[Math.floor(this.rng() * pool.length)];
      this.gesture = { def, startedAt: t };
      this.lastGesture = def.name;
    }
    let ge = 0;
    if (this.gesture) {
      const p = (t - this.gesture.startedAt) / this.gesture.def.duration;
      ge = env(p);
      if (this.gesture.def.pulses) ge *= 0.8 + 0.2 * Math.sin(2 * Math.PI * this.gesture.def.pulses * p - Math.PI / 2) ;
    }
    // A gesture that is running keeps full weight even if speech just ended,
    // but its envelope already returns to 0, so no jump occurs.
    const g = this.gesture?.def;
    const gestureArm = (side: 'left' | 'right'): Partial<ArmPose> => (g && g[side]) || {};

    // ── breathing and idle sway ─────────────────────────────────────────
    const breath = Math.sin((2 * Math.PI * t) / 4.2);
    const sway = (a: number, f: number, ph = 0) => a * Math.sin(2 * Math.PI * f * t + ph);

    const head: HeadPose = {
      pitch: sway(0.018, 0.21, 1.3) + 0.03 * b.listening - 0.06 * b.thinking + (g?.head?.pitch ?? 0) * ge,
      yaw:   sway(0.035, 0.13) + sway(0.015, 0.31, 0.7) + 0.13 * b.thinking * 1 + (g?.head?.yaw ?? 0) * ge
             + sway(0.03, 0.18, 2) * b.speaking,
      roll:  sway(0.014, 0.17, 2.1) + 0.045 * b.listening + 0.07 * b.thinking,
    };
    // slow attentive nodding while listening
    head.pitch += b.listening * 0.025 * Math.max(0, Math.sin(2 * Math.PI * 0.2 * t));

    const spine: HeadPose = {
      pitch: 0.011 * breath + 0.035 * b.listening - 0.01 * b.thinking,
      yaw: sway(0.012, 0.11, 0.4),
      roll: sway(0.008, 0.09, 1.7),
    };

    // ── arms: rest + thinking pose + gesture ───────────────────────────
    const arm = (side: 'left' | 'right'): ArmPose => {
      const gv = gestureArm(side);
      // Almost no idle motion: arms must read as straight along the body.
      const idleSway = sway(0.006, 0.19, side === 'left' ? 0 : 1.1);
      return {
        down:    REST_ARM.down + idleSway + (gv.down ?? 0) * ge,
        forward: REST_ARM.forward + (gv.forward ?? 0) * ge,
        elbow:   REST_ARM.elbow + (gv.elbow ?? 0) * ge,
        wrist:   REST_ARM.wrist + (gv.wrist ?? 0) * ge,
      };
    };

    // ── blinking ────────────────────────────────────────────────────────
    if (t >= this.blinkAt) {
      this.blinkStart = t;
      const double = this.rng() < 0.12;
      this.blinkAt = t + (double ? 0.35 : 2.2 + this.rng() * 3.6);
    }
    const bp = (t - this.blinkStart) / this.blinkDur;
    const blink = bp >= 0 && bp <= 1 ? Math.sin(Math.PI * bp) : 0;

    // ── expressions ─────────────────────────────────────────────────────
    // `happy` stays low so it does not fight the mouth visemes.
    const expr: Expressions = {
      blink,
      happy: 0.07 + 0.1 * b.listening + 0.16 * b.speaking - 0.05 * b.thinking,
      relaxed: 0.08 * b.thinking,
      lookUp: 0.28 * b.thinking,
    };

    // ── mouth ───────────────────────────────────────────────────────────
    const target = state === 'SPEAKING' ? mouthTarget : closedMouth();
    const mouth = this.mouth.step(dt, target);

    // small speech-driven head bob
    const energy = mouth.aa + mouth.oh + mouth.ou + mouth.ee + mouth.ih;
    head.pitch += 0.018 * energy * b.speaking;

    return {
      spine, head,
      leftArm: arm('left'),
      rightArm: arm('right'),
      shoulderLift: 0.012 * breath,
      expr,
      mouth,
    };
  }
}
