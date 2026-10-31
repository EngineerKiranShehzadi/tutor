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
// @ ( ), plus a single space or line break between digit groups, as in
// "0300 1234567"). No PII pattern can cross the character where the tail
// starts, so the settled part redacts the same way now as it will in the
// whole answer, and its redacted form only ever grows. Only redacted settled
// text is sent; the tail is sent (redacted) once it settles or at flush().
// The cost is that the last word or number shows up one piece later.

const RUN_CHAR = /[A-Za-z0-9._%+\-@()]/;
const GROUP_END = /[0-9)]/;   // a phone/card group can end with these…
const GROUP_START = /[0-9(]/; // …and the next group can start with these

// Index where the held-back tail of `text` starts (text.length = nothing held).
export function settledLength(text: string): number {
  let i = text.length;
  while (i > 0) {
    const c = text[i - 1];
    if (RUN_CHAR.test(c)) { i--; continue; }
    // One whitespace between digit groups belongs to the run. At the very end
    // the next group may not have arrived yet, so hold it too.
    if (/\s/.test(c) && i - 2 >= 0 && GROUP_END.test(text[i - 2]) && (i === text.length || GROUP_START.test(text[i]))) {
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
  let sent = 0; // length of the redacted text already sent

  const emitUpTo = (end: number): void => {
    const redacted = scanForPii(raw.slice(0, end)).sanitizedText;
    if (redacted.length > sent) {
      target.onDelta(redacted.slice(sent));
      sent = redacted.length;
    }
  };

  return {
    onDelta(text: string): void {
      raw += text;
      emitUpTo(settledLength(raw));
    },
    onReset(): void {
      raw = '';
      sent = 0;
      target.onReset?.();
    },
    flush(): void {
      emitUpTo(raw.length);
    },
  };
}
