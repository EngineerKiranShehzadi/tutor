// Text-derived viseme timelines for lip synchronisation.
//
// IMPORTANT — what this is and is not:
// The browser's speechSynthesis API gives no audio samples and no phoneme or
// viseme timing. So this module cannot be audio-driven or phoneme-accurate.
// It builds an *approximate* mouth-shape timeline from the spoken text's
// spelling (vowel/consonant classes), paced by the utterance rate, and the
// speech controller re-aligns it to the real speech with word `boundary`
// events when the browser fires them. Mouth shapes therefore follow the
// words being spoken, but exact phoneme timing is NOT guaranteed.

export type VisemeKey = 'aa' | 'ih' | 'ou' | 'ee' | 'oh';
export const VISEME_KEYS: VisemeKey[] = ['aa', 'ih', 'ou', 'ee', 'oh'];

export type MouthWeights = Record<VisemeKey, number>;
export const closedMouth = (): MouthWeights => ({ aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 });

export interface VisemeSegment {
  startMs: number;
  endMs: number;
  /** null = mouth closed / resting (bilabials, pauses, punctuation) */
  viseme: VisemeKey | null;
  /** peak opening for this segment, 0..1 */
  weight: number;
  /** index into the source text this segment was produced from */
  charIndex: number;
}

export interface LipSyncTimeline {
  segments: VisemeSegment[];
  durationMs: number;
}

// Base durations at rate 1.0 (ms). Roughly conversational English: ~13 chars/s.
const VOWEL_MS = 92;
const CONSONANT_MS = 52;
const SPACE_MS = 60;
const COMMA_MS = 170;
const STOP_MS = 360;

const VOWEL_WEIGHT: Record<VisemeKey, number> = { aa: 0.95, oh: 0.85, ou: 0.75, ee: 0.65, ih: 0.55 };

// Digraphs first, then single letters.
const DIGRAPHS: [string, VisemeKey][] = [
  ['oo', 'ou'], ['ou', 'ou'], ['ew', 'ou'],
  ['ee', 'ee'], ['ea', 'ee'], ['ie', 'ee'], ['ai', 'ee'], ['ay', 'ee'], ['ei', 'ee'],
  ['oa', 'oh'], ['ow', 'oh'], ['oi', 'oh'], ['oy', 'oh'],
  ['au', 'aa'], ['aw', 'aa'],
];
const SINGLE_VOWELS: Record<string, VisemeKey> = { a: 'aa', e: 'ee', i: 'ih', o: 'oh', u: 'ou' };
const BILABIALS = new Set(['b', 'm', 'p']);          // lips close
const LABIODENTALS = new Set(['f', 'v']);            // lip-teeth: small opening
const ROUNDED = new Set(['w', 'q']);                 // lips round

interface Token { viseme: VisemeKey | null; weight: number; ms: number; charIndex: number }

const tokenize = (text: string): Token[] => {
  const out: Token[] = [];
  const t = text.toLowerCase();
  let i = 0;
  while (i < t.length) {
    const ch = t[i];
    const pair = t.slice(i, i + 2);

    const di = DIGRAPHS.find(([d]) => d === pair);
    if (di) { out.push({ viseme: di[1], weight: VOWEL_WEIGHT[di[1]], ms: VOWEL_MS * 1.25, charIndex: i }); i += 2; continue; }

    if (ch in SINGLE_VOWELS) {
      const v = SINGLE_VOWELS[ch];
      out.push({ viseme: v, weight: VOWEL_WEIGHT[v], ms: VOWEL_MS, charIndex: i });
    } else if (ch === 'y') {
      // "y" is a vowel at the end of a word / between consonants, a glide otherwise.
      const atWordEnd = i === t.length - 1 || !/[a-z]/.test(t[i + 1]);
      out.push(atWordEnd
        ? { viseme: 'ee', weight: VOWEL_WEIGHT.ee, ms: VOWEL_MS, charIndex: i }
        : { viseme: 'ih', weight: 0.3, ms: CONSONANT_MS, charIndex: i });
    } else if (/[a-z]/.test(ch)) {
      if (BILABIALS.has(ch)) out.push({ viseme: null, weight: 0, ms: CONSONANT_MS, charIndex: i });
      else if (LABIODENTALS.has(ch)) out.push({ viseme: 'ih', weight: 0.3, ms: CONSONANT_MS, charIndex: i });
      else if (ROUNDED.has(ch)) out.push({ viseme: 'ou', weight: 0.5, ms: CONSONANT_MS, charIndex: i });
      else out.push({ viseme: 'ih', weight: 0.18, ms: CONSONANT_MS, charIndex: i });   // lightly open jaw
    } else if (/\s/.test(ch)) {
      out.push({ viseme: null, weight: 0, ms: SPACE_MS, charIndex: i });
    } else if (/[,;:]/.test(ch)) {
      out.push({ viseme: null, weight: 0, ms: COMMA_MS, charIndex: i });
    } else if (/[.!?\n]/.test(ch)) {
      out.push({ viseme: null, weight: 0, ms: STOP_MS, charIndex: i });
    } else if (/[0-9]/.test(ch)) {
      out.push({ viseme: 'oh', weight: 0.45, ms: VOWEL_MS, charIndex: i });            // digits: open-ish
    }
    // any other symbol: no segment
    i += 1;
  }
  return out;
};

/**
 * Builds an approximate viseme timeline for one chunk of spoken text.
 * `rate` is the SpeechSynthesisUtterance rate (1 = normal); lower = slower.
 */
export const buildTimeline = (text: string, rate = 1): LipSyncTimeline => {
  const speed = rate > 0 ? rate : 1;
  const segments: VisemeSegment[] = [];
  let cursor = 0;
  for (const tok of tokenize(text)) {
    const dur = tok.ms / speed;
    segments.push({ startMs: cursor, endMs: cursor + dur, viseme: tok.viseme, weight: tok.weight, charIndex: tok.charIndex });
    cursor += dur;
  }
  return { segments, durationMs: cursor };
};

/** Time (ms from chunk start) at which the segment for `charIndex` begins; used to re-align on boundary events. */
export const timeForChar = (tl: LipSyncTimeline, charIndex: number): number => {
  if (tl.segments.length === 0) return 0;
  const seg = tl.segments.find(s => s.charIndex >= charIndex);
  return seg ? seg.startMs : tl.durationMs;
};

const smooth = (x: number) => x * x * (3 - 2 * x);   // smoothstep

/**
 * Target mouth weights at `tMs` (ms from chunk start). Each segment ramps open
 * over its first third and closes over its last third, so neighbouring
 * visemes cross-fade instead of snapping. Returns a closed mouth outside the
 * timeline.
 */
export const sampleTimeline = (tl: LipSyncTimeline, tMs: number): MouthWeights => {
  const w = closedMouth();
  if (tMs < 0 || tMs >= tl.durationMs) return w;
  const seg = tl.segments.find(s => tMs >= s.startMs && tMs < s.endMs);
  if (!seg || seg.viseme === null) return w;
  const len = seg.endMs - seg.startMs;
  const p = (tMs - seg.startMs) / len;
  const env = p < 0.33 ? smooth(p / 0.33) : p > 0.67 ? smooth((1 - p) / 0.33) : 1;
  w[seg.viseme] = seg.weight * env;
  return w;
};

/** Exponential smoothing with separate attack/release so the mouth neither snaps nor lags. */
export class MouthSmoother {
  private cur = closedMouth();
  constructor(private attackPerSec = 28, private releasePerSec = 16) {}

  step(dtSec: number, target: MouthWeights): MouthWeights {
    for (const k of VISEME_KEYS) {
      const rate = target[k] > this.cur[k] ? this.attackPerSec : this.releasePerSec;
      this.cur[k] += (target[k] - this.cur[k]) * (1 - Math.exp(-rate * Math.max(0, dtSec)));
    }
    // Total opening is capped so stacked visemes never over-open the jaw.
    const sum = VISEME_KEYS.reduce((a, k) => a + this.cur[k], 0);
    if (sum > 1) for (const k of VISEME_KEYS) this.cur[k] /= sum;
    return { ...this.cur };
  }

  reset(): void { this.cur = closedMouth(); }
}
