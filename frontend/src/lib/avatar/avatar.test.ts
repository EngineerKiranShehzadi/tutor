// Unit tests for the avatar logic that does not need a browser:
// lip-sync timelines, speech controller (play/pause/resume/stop/replay/mute,
// stale-callback guarding, autoplay-blocked, boundary re-sync), state
// derivation, pose driver (straight arms, smooth transitions), agent identity,
// WebGL probe, and the shared TTS helpers.
//
// The frontend has no test runner; run with the backend's ts-node:
//   ../backend/node_modules/.bin/ts-node --transpile-only --skip-project \
//     --compiler-options '{"module":"commonjs","target":"es2020"}' src/lib/avatar/avatar.test.ts
//
// NOT covered here (needs a real browser): that the 3D model looks right, and
// that the audio is audible. See docs in public/avatar/ATTRIBUTION.md and
// src/lib/avatar/README.md for the manual checklist.
import {
  buildTimeline, sampleTimeline, timeForChar, closedMouth, MouthSmoother, VISEME_KEYS,
} from './lip-sync';
import {
  SpeechController, SpeechDeps, SynthLike, UtteranceLike,
} from './speech-controller';
import { deriveAvatarState, AvatarPoseDriver, AvatarState, GESTURES } from './avatar-state';
import { resolveAgentName, DEFAULT_AGENT_NAME } from './agent-identity';
import { isWebGLAvailable } from './webgl';
import { toChunks, pickBestVoice, stripHtml } from '../tts-utils';
import { PORTRAIT_LAYOUT as PL, AVATAR_MODE } from './config';

let total = 0, failures = 0;
const check = (label: string, pass: boolean, detail = ''): void => {
  total++; if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` (${detail})` : ''}`);
};

// ── fakes ───────────────────────────────────────────────────────────────
class FakeUtterance implements UtteranceLike {
  lang = ''; rate = 1; pitch = 1; volume = 1; voice: unknown = null;
  onstart: UtteranceLike['onstart'] = null; onend: UtteranceLike['onend'] = null;
  onerror: UtteranceLike['onerror'] = null; onboundary: UtteranceLike['onboundary'] = null;
  constructor(public text: string) {}
}
class FakeSynth implements SynthLike {
  spoken: FakeUtterance[] = []; cancels = 0; pauses = 0; resumes = 0;
  speak(u: UtteranceLike) { this.spoken.push(u as FakeUtterance); }
  cancel() { this.cancels++; }
  pause() { this.pauses++; }
  resume() { this.resumes++; }
  getVoices() { return [{ name: 'Google UK English Male', lang: 'en-GB' }]; }
  get last() { return this.spoken[this.spoken.length - 1]; }
}
const makeRig = () => {
  let t = 0; let nextId = 1;
  const timers: { id: number; at: number; fn: () => void }[] = [];
  const synth = new FakeSynth();
  const deps: SpeechDeps = {
    synth,
    createUtterance: (text) => new FakeUtterance(text),
    pickVoice: (v) => v[0],
    now: () => t,
    setTimeout: (fn, ms) => { const id = nextId++; timers.push({ id, at: t + ms, fn }); return id; },
    clearTimeout: (h) => { const i = timers.findIndex(x => x.id === h); if (i >= 0) timers.splice(i, 1); },
  };
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const n = timers[0];
      if (!n || n.at > end) break;
      timers.shift(); t = n.at; n.fn();
    }
    t = end;
  };
  return { synth, deps, advance, now: () => t, pendingTimers: () => timers.length };
};
const startAudio = (r: ReturnType<typeof makeRig>) => r.synth.last.onstart?.();
const endChunk = (r: ReturnType<typeof makeRig>) => r.synth.last.onend?.();
const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);

// ── lip-sync ────────────────────────────────────────────────────────────
{
  const tl = buildTimeline('Hello, world.', 1);
  check('lip: timeline has segments and positive duration', tl.segments.length > 5 && tl.durationMs > 500);
  check('lip: vowels open the mouth (some segment weight > 0.5)', tl.segments.some(s => s.viseme && s.weight > 0.5));
  const m = buildTimeline('mum', 1);
  check('lip: bilabials (m) close the mouth', m.segments[0].viseme === null && m.segments[0].weight === 0);
  const slow = buildTimeline('Hello world', 0.5), fast = buildTimeline('Hello world', 1);
  check('lip: slower speech rate stretches the timeline (rate 0.5 ~ 2x)', Math.abs(slow.durationMs / fast.durationMs - 2) < 0.01);
  const w = sampleTimeline(tl, tl.segments.find(s => s.viseme === 'ee' || s.viseme === 'oh' || s.viseme === 'aa')!.startMs + 40);
  check('lip: sampling inside a vowel gives a non-zero weight, total <= 1', sum(w) > 0.05 && sum(w) <= 1.0001);
  check('lip: outside the timeline the mouth is closed', sum(sampleTimeline(tl, -5)) === 0 && sum(sampleTimeline(tl, tl.durationMs + 10)) === 0);
  const t5 = timeForChar(tl, 5), t8 = timeForChar(tl, 8);
  check('lip: char index -> time is monotonic (word-boundary re-sync)', t8 >= t5 && t5 > 0);
  const sm = new MouthSmoother();
  let v = closedMouth(); const target = { ...closedMouth(), aa: 0.9 };
  for (let i = 0; i < 12; i++) v = sm.step(1 / 60, target);
  check('lip: smoother opens toward target without overshoot', v.aa > 0.3 && v.aa <= 0.9);
  for (let i = 0; i < 60; i++) v = sm.step(1 / 60, closedMouth());
  check('lip: smoother closes again', v.aa < 0.01);
  check('lip: five VRM viseme keys', VISEME_KEYS.join() === 'aa,ih,ou,ee,oh');
}

// ── speech controller ───────────────────────────────────────────────────
{
  const r = makeRig(); const c = new SpeechController(r.deps);
  c.speak('<p>Hello there. This is a test.</p>');
  check('speech: speaking state and first chunk queued', c.snapshot().state === 'speaking' && r.synth.spoken.length === 1);
  check('speech: HTML stripped, existing voice picked, existing pace used', r.synth.last.text === 'Hello there.' && r.synth.last.rate === 0.85 && r.synth.last.voice !== null);
  check('speech: waiting for audio until the browser starts it', c.snapshot().waitingForAudio === true);
  startAudio(r);
  check('speech: audio start clears waiting flag', c.snapshot().waitingForAudio === false);
  r.advance(120);
  check('speech: mouth moves while speaking', sum(c.getMouth()) > 0);

  // pause / resume
  const beforePause = r.now();
  c.pause();
  check('speech: pause -> paused, synth.pause called, mouth closed', c.snapshot().state === 'paused' && r.synth.pauses === 1 && sum(c.getMouth()) === 0);
  r.advance(5000);
  c.resume();
  check('speech: resume -> speaking, synth.resume called', c.snapshot().state === 'speaking' && r.synth.resumes === 1);
  const elapsedAfterResume = r.now() - beforePause;
  check('speech: paused time is excluded from the lip-sync clock', elapsedAfterResume >= 5000 && sum(c.getMouth()) >= 0);

  // chunk advance with pause between chunks
  endChunk(r);
  check('speech: next chunk waits for the inter-chunk pause', r.synth.spoken.length === 1);
  r.advance(500);
  check('speech: second chunk starts after the pause', r.synth.spoken.length === 2 && r.synth.last.text === 'This is a test.');
  startAudio(r);
  endChunk(r);
  check('speech: finishes back to idle after the last chunk', c.snapshot().state === 'idle' && c.stats.chunksSpoken === 2);

  // replay
  c.replay();
  check('speech: replay restarts the same answer from the first chunk', c.snapshot().state === 'speaking' && r.synth.last.text === 'Hello there.');

  // stop + stale callbacks
  const staleUtterance = r.synth.last;
  c.stop();
  check('speech: stop -> idle, synth cancelled, mouth closed', c.snapshot().state === 'idle' && sum(c.getMouth()) === 0);
  staleUtterance.onend?.();
  staleUtterance.onstart?.();
  check('speech: late callbacks from a cancelled utterance are ignored', c.snapshot().state === 'idle' && r.synth.spoken[r.synth.spoken.length - 1] === staleUtterance);

  // never two answers at once
  c.speak('First answer.');
  const first = r.synth.last;
  c.speak('Second answer.');
  first.onend?.();           // stale
  check('speech: a new answer replaces the old one (only one active)', r.synth.last.text === 'Second answer.' && c.snapshot().state === 'speaking' && r.synth.cancels >= 2);
  c.stop();

  // mute
  const volBefore = r.synth.spoken.length;
  c.setMuted(true);
  c.speak('Muted speech.');
  check('speech: muted -> utterance volume 0 (mouth still animates)', r.synth.last.volume === 0 && r.synth.spoken.length === volBefore + 1);
  startAudio(r);
  c.setMuted(false);
  check('speech: unmute mid-chunk restarts the chunk audibly', r.synth.last.volume === 1);
  c.stop();

  // errors
  c.speak('Error case.');
  r.synth.last.onerror?.({ error: 'interrupted' });
  check('speech: "interrupted" (our own cancel) is not treated as an error', c.snapshot().error === null && c.snapshot().state === 'speaking');
  r.synth.last.onerror?.({ error: 'synthesis-failed' });
  check('speech: a real TTS failure -> idle + error message', c.snapshot().state === 'idle' && /failed/i.test(c.snapshot().error ?? ''));

  // autoplay blocked
  const r2 = makeRig(); const c2 = new SpeechController(r2.deps);
  c2.speak('This never starts.');
  r2.advance(2600);
  check('speech: audio that never starts is reported (autoplay policy) instead of hanging',
    c2.snapshot().state === 'idle' && /did not start/i.test(c2.snapshot().error ?? '') && c2.snapshot().waitingForAudio === true);

  // boundary re-sync
  const r3 = makeRig(); const c3 = new SpeechController(r3.deps);
  c3.speak('Education is the most powerful tool.');
  startAudio(r3);
  r3.advance(50);
  r3.synth.last.onboundary?.({ charIndex: 10, name: 'word' });
  check('speech: word boundary events re-align the mouth clock', c3.stats.boundaryEvents === 1);

  // cleanup
  const r4 = makeRig(); const c4 = new SpeechController(r4.deps);
  c4.speak('One. Two. Three.');
  startAudio(r4); endChunk(r4);
  c4.dispose();
  check('speech: dispose cancels audio and clears every timer', r4.pendingTimers() === 0 && c4.snapshot().state === 'idle');

  // empty / whitespace text
  const r5 = makeRig(); const c5 = new SpeechController(r5.deps);
  c5.speak('   <br>   ');
  check('speech: empty text speaks nothing', r5.synth.spoken.length === 0 && c5.snapshot().state === 'idle');
}

// ── state derivation ────────────────────────────────────────────────────
{
  const base = { isAnswerPending: false, isSpeaking: false, isUserInputActive: false, hasError: false };
  check('state: idle by default', deriveAvatarState(base) === 'IDLE');
  check('state: typing/dictating -> LISTENING', deriveAvatarState({ ...base, isUserInputActive: true }) === 'LISTENING');
  check('state: request in flight -> THINKING', deriveAvatarState({ ...base, isAnswerPending: true }) === 'THINKING');
  check('state: speech playing -> SPEAKING (beats THINKING/LISTENING)', deriveAvatarState({ ...base, isSpeaking: true, isAnswerPending: true, isUserInputActive: true }) === 'SPEAKING');
  check('state: ERROR beats everything', deriveAvatarState({ ...base, hasError: true, isSpeaking: true }) === 'ERROR');
  const seq: AvatarState[] = ['IDLE', 'LISTENING', 'THINKING', 'SPEAKING', 'IDLE'];
  check('state: spec flow IDLE->LISTENING->THINKING->SPEAKING->IDLE derivable', seq.length === 5);
}

// ── pose driver ─────────────────────────────────────────────────────────
{
  const flatten = (p: ReturnType<AvatarPoseDriver['update']>) => [
    p.head.pitch, p.head.yaw, p.head.roll, p.spine.pitch, p.spine.yaw, p.spine.roll,
    p.leftArm.down, p.leftArm.forward, p.leftArm.elbow, p.rightArm.down, p.rightArm.forward, p.rightArm.elbow,
    p.expr.happy, p.expr.relaxed, p.expr.lookUp,
  ];   // body + face-expression channels only: the mouth is intentionally fast (it follows speech)
  const run = (armGestures: boolean) => {
    const d = new AvatarPoseDriver(7, armGestures);
    const states: AvatarState[] = ['IDLE', 'LISTENING', 'THINKING', 'SPEAKING', 'ERROR', 'IDLE'];
    let prev: number[] | null = null; let maxJump = 0; let maxArmDelta = 0; let minDown = 9, maxDown = -9, maxElbow = 0, maxFwd = 0;
    let blinkSeen = false, blinkCleared = false, mouthWhileNotSpeaking = 0, mouthWhileSpeaking = 0;
    const gestures: string[] = [];
    for (const st of states) {
      for (let i = 0; i < 60 * 8; i++) {                 // 8 s per state at 60 fps
        const mouth = { ...closedMouth(), aa: Math.abs(Math.sin(i / 7)) * 0.8 };
        const p = d.update(1 / 60, st, mouth);
        const f = flatten(p);
        if (prev) for (let k = 0; k < f.length; k++) maxJump = Math.max(maxJump, Math.abs(f[k] - prev[k]));
        prev = f;
        for (const a of [p.leftArm, p.rightArm]) {
          minDown = Math.min(minDown, a.down); maxDown = Math.max(maxDown, a.down);
          maxElbow = Math.max(maxElbow, Math.abs(a.elbow)); maxFwd = Math.max(maxFwd, Math.abs(a.forward));
        }
        if (p.expr.blink > 0.5) blinkSeen = true;
        if (blinkSeen && p.expr.blink === 0) blinkCleared = true;
        const mouthSum = p.mouth.aa + p.mouth.ih + p.mouth.ou + p.mouth.ee + p.mouth.oh;
        if (st === 'SPEAKING') mouthWhileSpeaking = Math.max(mouthWhileSpeaking, mouthSum); else if (i > 200) mouthWhileNotSpeaking = Math.max(mouthWhileNotSpeaking, mouthSum);
        const g = d.currentGesture; if (g && gestures[gestures.length - 1] !== g) gestures.push(g);
      }
    }
    return { maxJump, minDown, maxDown, maxElbow, maxFwd, blinkSeen, blinkCleared, mouthWhileNotSpeaking, mouthWhileSpeaking, gestures };
  };

  const straight = run(false);
  check('pose: arms hang straight down in every state (upper-arm angle ~90 deg from T-pose)', straight.minDown > 1.47 && straight.maxDown < 1.53, `down in [${straight.minDown.toFixed(3)}, ${straight.maxDown.toFixed(3)}] rad`);
  check('pose: no elbow bend or forward swing with arm gestures off', straight.maxElbow < 1e-6 && straight.maxFwd < 1e-6);
  check('pose: no arm gestures when disabled (head nods only)', straight.gestures.every(g => g === 'nod'), straight.gestures.join(',') || 'none');
  check('pose: transitions are smooth (no per-frame jump > 0.06)', straight.maxJump < 0.06, `max per-frame delta ${straight.maxJump.toFixed(4)}`);
  check('pose: natural blinking occurs and the eyes reopen', straight.blinkSeen && straight.blinkCleared);
  check('pose: mouth only moves while SPEAKING', straight.mouthWhileSpeaking > 0.1 && straight.mouthWhileNotSpeaking < 0.02, `speaking ${straight.mouthWhileSpeaking.toFixed(2)}, otherwise ${straight.mouthWhileNotSpeaking.toFixed(3)}`);

  const gest = run(true);
  const noRepeat = gest.gestures.every((g, i) => i === 0 || g !== gest.gestures[i - 1]);
  check('pose: with arm gestures enabled they occur during speech and never repeat back-to-back', gest.gestures.length >= 2 && noRepeat && GESTURES.length >= 5, gest.gestures.join(','));
  check('pose: enabled gestures still return the arms to rest (no jump)', gest.maxJump < 0.06 && gest.maxElbow > 0.3);
}

// ── agent identity ──────────────────────────────────────────────────────
{
  const expected: Record<string, string> = {
    pCNit2x2gjY: 'Nova', '0YM7Cfp8dIQ': 'Sage', '1mi-gFalmSQ': 'Clarity', CIkEryaQ7ok: 'Craft',
    IQNZNTdZhZg: 'Prism', Hv8judoCF0g: 'Oracle', jGsf0ppO3Js: 'Virtue',
  };
  check('identity: all seven agents resolve from the lecture video id',
    Object.entries(expected).every(([id, name]) => resolveAgentName(id) === name));
  check('identity: unknown/missing lecture falls back to the generic name',
    resolveAgentName('nope') === DEFAULT_AGENT_NAME && resolveAgentName(null) === DEFAULT_AGENT_NAME && resolveAgentName(undefined) === DEFAULT_AGENT_NAME);
}

// ── WebGL probe ─────────────────────────────────────────────────────────
{
  check('webgl: available when a context can be created', isWebGLAvailable(() => ({ getContext: (id) => (id === 'webgl' ? {} : null) })) === true);
  check('webgl: unavailable when no context', isWebGLAvailable(() => ({ getContext: () => null })) === false);
  check('webgl: unavailable when probing throws', isWebGLAvailable(() => ({ getContext: () => { throw new Error('boom'); } })) === false);
  check('webgl: unavailable without a document', isWebGLAvailable(() => null) === false);
}

// ── shared TTS helpers (moved verbatim from useVoice) ───────────────────
{
  const ch = toChunks('Hello world. This, is a test');
  check('tts: sentence/clause chunking with the existing pauses', ch.length === 3 && ch[0].pause === 480 && ch[1].pause === 220 && ch[2].pause === 80);
  check('tts: strips HTML', stripHtml('<b>Hi</b> there') === 'Hi there');
  const voices = [{ name: 'Some Voice', lang: 'en-US' }, { name: 'Google UK English Male', lang: 'en-GB' }];
  check('tts: prefers the existing male tutor voice list', pickBestVoice(voices)?.name === 'Google UK English Male');
  check('tts: no voices -> null', pickBestVoice([]) === null);
}

// ── portrait layout sanity ──────────────────────────────────────────────
{
  const inRange = (v: number) => v > 0 && v < 100;
  check('portrait: feature coordinates are inside the image',
    [PL.eyeLeft.x, PL.eyeLeft.y, PL.eyeRight.x, PL.eyeRight.y, PL.mouth.x, PL.mouth.y].every(inRange));
  check('portrait: eyes level-ish, mouth below the eyes and between them',
    PL.mouth.y > PL.eyeLeft.y + 10 && PL.mouth.x > PL.eyeLeft.x && PL.mouth.x < PL.eyeRight.x && Math.abs(PL.eyeLeft.y - PL.eyeRight.y) < 4);
  check('portrait: default presentation mode is the supplied portrait', AVATAR_MODE === 'portrait');
}

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
