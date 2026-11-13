/** Cheap lexical gate; semantic novelty is also checked by the existing verifier.
 * It deliberately does not claim to recognize every possible paraphrase. */
export interface PreviousQuestion { lectureId: number; question: string; sourceId: number | null }
export const normalizeQuestion = (text: string): string => text.normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const stop = new Set('a an the is are was were be been to of in on for from and or which what how does do did would could should according lecture following statement statements best describes describe'.split(' '));
const tokens = (text: string) => new Set(normalizeQuestion(text).split(' ').filter(t => t && !stop.has(t)));
function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let common = 0; for (const word of a) if (b.has(word)) common++;
  return 2 * common / (a.size + b.size);
}
export function repeatsQuestion(text: string, previous: readonly string[]): boolean {
  const normalized = normalizeQuestion(text);
  const words = tokens(text);
  return previous.some(old => {
    if (normalized === normalizeQuestion(old)) return true;
    const other = tokens(old);
    // Keep quantities and negation: similar wording about different numbers or
    // "not" is not rejected just because the rest of the sentence is shared.
    const critical = (set: Set<string>) => [...set].filter(t => /\d/.test(t) || ['not','never','except','without'].includes(t)).sort().join('|');
    return words.size >= 4 && other.size >= 4 && critical(words) === critical(other) && dice(words, other) >= 0.88;
  });
}
