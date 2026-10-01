import {
  SQL_INJECTION_PATTERNS,
  XSS_PATTERNS,
  SHELL_COMMAND_PATTERNS,
  PATH_TRAVERSAL_PATTERNS,
  TEMPLATE_INJECTION_PATTERNS,
  EDUCATIONAL_FRAMING_PATTERNS,
  DIRECT_EXECUTION_IMPERATIVE_PATTERNS,
} from '../patterns/malicious-payload.patterns';
import type { InputGuardrailResult } from '../types/input-guardrail.types';

const SIGNAL_GROUPS: Record<string, RegExp[]> = {
  SQL_INJECTION: SQL_INJECTION_PATTERNS,
  XSS: XSS_PATTERNS,
  SHELL_COMMAND: SHELL_COMMAND_PATTERNS,
  PATH_TRAVERSAL: PATH_TRAVERSAL_PATTERNS,
  TEMPLATE_INJECTION: TEMPLATE_INJECTION_PATTERNS,
};

function matchedSignalCategories(text: string): string[] {
  return Object.entries(SIGNAL_GROUPS)
    .filter(([, patterns]) => patterns.some(re => re.test(text)))
    .map(([category]) => category);
}

const hasEducationalFraming = (text: string): boolean =>
  EDUCATIONAL_FRAMING_PATTERNS.some(re => re.test(text));

const hasDirectExecutionImperative = (text: string): boolean =>
  DIRECT_EXECUTION_IMPERATIVE_PATTERNS.some(re => re.test(text));

// Detects active-manipulation intent, not merely suspicious syntax:
//
//   suspicious syntax found?
//     no  -> ALLOW (nothing to look at)
//     yes -> educational framing OR no direct execution imperative -> ALLOW
//            direct execution imperative AND no educational framing -> REJECT
//
// Deliberately biased toward ALLOW: this dataset's course legitimately
// teaches SQL injection, XSS, shell/path-traversal and template-injection
// examples, and the backend's real defenses (parameterized queries, no
// eval/shell interpolation — see chunk.service.ts, config/database.ts) do
// not depend on this guard catching everything. It exists to catch
// blatant, directly-addressed attempts, not to replace secure coding.
export function checkMaliciousPayload(text: string): InputGuardrailResult {
  const categories = matchedSignalCategories(text);
  if (categories.length === 0) {
    return { action: 'ALLOW' };
  }

  const educational = hasEducationalFraming(text);
  const directive = hasDirectExecutionImperative(text);

  if (directive && !educational) {
    return {
      action: 'REJECT',
      reason: 'MALICIOUS_PAYLOAD',
      metadata: { detectedCategories: categories },
    };
  }

  return {
    action: 'ALLOW',
    metadata: { detectedCategories: categories, framing: educational ? 'EDUCATIONAL' : 'AMBIGUOUS' },
  };
}
