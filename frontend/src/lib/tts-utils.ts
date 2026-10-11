// Pure TTS helpers shared by useVoice.ts and the avatar speech controller.
// Moved verbatim from hooks/useVoice.ts so the existing voice selection and
// sentence/clause chunking stay the single implementation.

// Strip HTML tags before speaking
export const stripHtml = (html: string) => html.replace(/<[^>]*>/g, '');

// Pick the best available MALE TTS voice — tutor style, clear for Pakistani students
const MALE_VOICE_NAMES = [
  'Microsoft Prabhat Online (Natural) - English (India)',    // en-IN-PrabhatNeural — ideal
  'Microsoft Prabhat - English (India)',                      // older Windows, same voice
  'Microsoft Ravi - English (India)',                         // older male Indian English
  'Microsoft Guy Online (Natural) - English (United States)', // clear US male neural
  'Microsoft Ryan Online (Natural) - English (United Kingdom)', // clear UK male neural
  'Microsoft Davis Online (Natural) - English (United States)',
  'Microsoft David Online (Natural) - English (United States)',
  'Microsoft Mark Online (Natural) - English (United States)',
  'Microsoft Thomas - English (United Kingdom)',
  'Google UK English Male',
  'Google US English',
];

const MALE_KEYWORDS = ['male', 'man', 'guy', 'david', 'mark', 'thomas', 'ryan',
                       'prabhat', 'ravi', 'davis', 'fred', 'alex', 'daniel'];

export interface VoiceLike { name: string; lang: string }

// `voices` is injectable so this stays testable without a browser.
export const pickBestVoice = <V extends VoiceLike>(voices: V[]): V | null => {
  // 1. Exact name match from priority list
  for (const name of MALE_VOICE_NAMES) {
    const v = voices.find(v => v.name === name);
    if (v) return v;
  }

  // 2. Any en-IN male voice by keyword heuristic
  const enIN = voices.filter(v => v.lang === 'en-IN');
  const maleEnIN = enIN.find(v => MALE_KEYWORDS.some(k => v.name.toLowerCase().includes(k)));
  if (maleEnIN) return maleEnIN;

  // 3. Any en-GB/en-US male voice by keyword heuristic
  const enOther = voices.filter(v => v.lang === 'en-GB' || v.lang === 'en-US');
  const maleEn = enOther.find(v => MALE_KEYWORDS.some(k => v.name.toLowerCase().includes(k)));
  if (maleEn) return maleEn;

  // 4. Any English voice as last resort
  return voices.find(v => v.lang.startsWith('en')) ?? voices[0] ?? null;
};

export const getBestVoice = (): SpeechSynthesisVoice | null =>
  pickBestVoice(window.speechSynthesis.getVoices());

export interface Chunk { text: string; pause: number }

// Split text into chunks with pause durations:
//   sentence endings (.!?) → 480 ms pause
//   clause breaks (,;:)    → 220 ms pause
//   everything else        →  80 ms pause
export const toChunks = (text: string): Chunk[] => {
  const parts = text.match(/[^.!?,;:\n]+[.!?,;:\n]?/g) ?? [text];
  return parts
    .map((part) => {
      const t = part.trim();
      if (!t) return null;
      const last = t.slice(-1);
      const pause = /[.!?]/.test(last) ? 480 : /[,;:]/.test(last) ? 220 : 80;
      return { text: t, pause };
    })
    .filter(Boolean) as Chunk[];
};
