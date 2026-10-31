import { scanForPii } from '../../shared/pii/pii-detector.service';
import type { AnswerStreamHandlers } from '../../../../services/llm-gemini.service';

// Redacts PII in the streamed draft BEFORE it is sent, using the same shared
// detector as the final-answer PII guard (output-pii-leakage.guard.ts).
// Groundedness and format are still checked only on the final answer (the
// `final` event replaces the draft); PII cannot wait for that, because text
// already painted on the student's screen cannot be taken back.
//
// How: the text is split into a settled part and a held-back tail. The tail is
// the trailing run of characters that could still grow into an email, phone,
// card, IP or ID number once more text arrives (letters, digits and . _ % + -
// @ ( ), plus a single space or line break after a digit group, as in
// "0300 1234567"). No PII pattern can cross the character where the tail
// starts, so the settled part redacts the same way now as it will in the
// whole answer, and its redacted form only ever grows. Only redacted settled
// text is sent; the tail is sent (redacted) once it settles or at flush().
// The cost is that the last word or number shows up one piece later.

const RUN_CHAR = /[A-Za-z0-9._%+\-@()]/;
const GROUP_END = /[0-9)]/;   // a phone/card group can end with these

// Index where the held-back tail of `text` starts (text.length = nothing held).
export function settledLength(text: string): number {
  let i = text.length;
  while (i > 0) {
    const c = text[i - 1];
    if (RUN_CHAR.test(c)) { i--; continue; }
    // One whitespace after a digit group belongs to the run: the next group
    // may follow it (or not have arrived yet), and a card number takes the
    // space after it into the match when a word follows ("…1111 end").
    if (/\s/.test(c) && i - 2 >= 0 && GROUP_END.test(text[i - 2])) {
      i--;
      continue;
    }
    break;
  }
  return i;
}

export interface PiiSafeStream extends AnswerStreamHandlers {
  // Sends whatever is still held back, redacted. Call once generation ends.
  flush(): void;
}

export function createPiiSafeStream(target: AnswerStreamHandlers): PiiSafeStream {
  let raw = '';
  // The redacted text already sent — the text itself, not its length. A longer
  // prefix almost always redacts to an extension of it, and then only the new
  // part is sent. Not always: a card number swallows the space after it only
  // when a word follows, so "4111 1111 1111 1111 " redacts to "[CREDIT_CARD] "
  // until "end" arrives and then to "[CREDIT_CARD]end". Slicing by length sent
  // "nd"; instead the draft is reset and resent (the final event replaces it
  // anyway). Without onReset nothing more is sent until the two agree.
  let shown = '';

  const emitUpTo = (end: number): void => {
    const redacted = scanForPii(raw.slice(0, end)).sanitizedText;
    if (redacted.startsWith(shown)) {
      if (redacted.length > shown.length) target.onDelta(redacted.slice(shown.length));
    } else if (target.onReset) {
      target.onReset();
      target.onDelta(redacted);
    } else {
      return;
    }
    shown = redacted;
  };

  return {
    onDelta(text: string): void {
      raw += text;
      emitUpTo(settledLength(raw));
    },
    onReset(): void {
      raw = '';
      shown = '';
      target.onReset?.();
    },
    flush(): void {
      emitUpTo(raw.length);
    },
  };
}
