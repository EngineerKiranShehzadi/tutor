import { env } from '../../../config/env';
import { checkInputLength } from './guards/input-length.guard';
import { checkMaliciousPayload } from './guards/malicious-payload.guard';
import { detectAndSanitizePii } from './guards/pii-detection.guard';
import { checkPromptInjection } from './guards/prompt-injection.guard';
import type { InputGuardrailMetadata, InputGuardrailResult } from './types/input-guardrail.types';

export { REJECTION_MESSAGE_BY_REASON } from './types/input-guardrail-reasons';
export type { InputGuardrailReason } from './types/input-guardrail-reasons';
export type { InputGuardrailAction, InputGuardrailResult } from './types/input-guardrail.types';

// Orchestration only — no PII regex, payload patterns, or LLM prompts live
// in this file; see guards/ (detection logic) and patterns/ (the actual
// regex groups) for those. Runs the fixed guard chain below, cheapest
// deterministic checks first, stopping immediately on a definitive REJECT
// and carrying any sanitized text forward into the next guard:
//
//   InputLengthGuard -> MaliciousPayloadGuard -> PiiDetectionGuard -> PromptInjectionGuard
//
// Called by chat.service.ts before query-router.service.ts runs — see
// askLectureAgent's 'input-guardrail' stage.
export async function runInputGuardrails(rawInput: string): Promise<InputGuardrailResult> {
  if (!env.INPUT_GUARDRAIL.ENABLED) {
    return { action: 'ALLOW', sanitizedInput: rawInput, metadata: { guardrailEnabled: false } };
  }

  // 1. Length — cheapest possible check, and the only one worth doing
  // before anything else even runs.
  const lengthResult = checkInputLength(rawInput, {
    maxChars: env.INPUT_GUARDRAIL.MAX_CHARS,
    maxTokens: env.INPUT_GUARDRAIL.MAX_TOKENS,
  });
  if (lengthResult.action === 'REJECT') return lengthResult;

  let current = rawInput;
  let sanitizeReason: InputGuardrailResult['reason'];
  const metadata: InputGuardrailMetadata = {};

  // 2. Malicious payload — deterministic signal + framing check.
  if (env.INPUT_GUARDRAIL.MALICIOUS_PAYLOAD_ENABLED) {
    const result = checkMaliciousPayload(current);
    if (result.action === 'REJECT') return result;
    const categories = result.metadata?.detectedCategories;
    if (categories) metadata.maliciousPayloadCategories = categories;
  }

  // 3. PII — never rejects, only sanitizes. The sanitized text is what
  // every guard from here on (and the query router afterward) evaluates.
  if (env.INPUT_GUARDRAIL.PII_ENABLED) {
    const result = detectAndSanitizePii(current);
    if (result.action === 'SANITIZE' && result.sanitizedInput !== undefined) {
      current = result.sanitizedInput;
      sanitizeReason = result.reason;
      metadata.piiDetected = true;
      metadata.piiCategories = result.metadata?.detectedCategories;
    }
  }

  // 4. Prompt injection — deterministic signals, semantic classifier only
  // for genuinely ambiguous input (see guards/prompt-injection.guard.ts).
  if (env.INPUT_GUARDRAIL.INJECTION_ENABLED) {
    const result = await checkPromptInjection(current);
    if (result.action === 'REJECT') {
      return { ...result, metadata: { ...metadata, ...result.metadata } };
    }
    Object.assign(metadata, result.metadata);
  }

  return {
    action: sanitizeReason ? 'SANITIZE' : 'ALLOW',
    reason: sanitizeReason,
    // Always the final text every guard actually agreed on — identical to
    // rawInput when nothing was sanitized, so callers can use this value
    // unconditionally instead of branching on `action`.
    sanitizedInput: current,
    metadata,
  };
}
