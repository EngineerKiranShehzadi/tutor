import {
  IGNORE_INSTRUCTIONS_PATTERNS,
  REVEAL_SYSTEM_PROMPT_PATTERNS,
  OVERRIDE_GROUNDING_PATTERNS,
  DISABLE_RESTRICTIONS_PATTERNS,
  IMPERSONATION_PATTERNS,
  EDUCATIONAL_FRAMING_PATTERNS,
  IMPERATIVE_FRAMING_PATTERNS,
} from '../patterns/prompt-injection.patterns';
import { classifyPromptInjection } from '../classifiers/prompt-injection-classifier.service';
import { env } from '../../../../config/env';
import { logger } from '../../../../utils/logger';
import type { InputGuardrailResult, InjectionDetectionMethod } from '../types/input-guardrail.types';

const SIGNAL_GROUPS: Record<string, RegExp[]> = {
  IGNORE_INSTRUCTIONS: IGNORE_INSTRUCTIONS_PATTERNS,
  REVEAL_SYSTEM_PROMPT: REVEAL_SYSTEM_PROMPT_PATTERNS,
  OVERRIDE_GROUNDING: OVERRIDE_GROUNDING_PATTERNS,
  DISABLE_RESTRICTIONS: DISABLE_RESTRICTIONS_PATTERNS,
  IMPERSONATION: IMPERSONATION_PATTERNS,
};

// Categories confident enough that "signal + imperative + no educational
// framing" can REJECT directly in Stage A without paying for an LLM call —
// see section 8's "clearly active injection -> reject" fast path.
const HIGH_CONFIDENCE_CATEGORIES = new Set([
  'IGNORE_INSTRUCTIONS', 'REVEAL_SYSTEM_PROMPT', 'DISABLE_RESTRICTIONS', 'OVERRIDE_GROUNDING',
]);

function matchedSignalCategories(text: string): string[] {
  return Object.entries(SIGNAL_GROUPS)
    .filter(([, patterns]) => patterns.some(re => re.test(text)))
    .map(([category]) => category);
}

const hasEducationalFraming = (text: string): boolean =>
  EDUCATIONAL_FRAMING_PATTERNS.some(re => re.test(text));

const hasImperativeFraming = (text: string): boolean =>
  IMPERATIVE_FRAMING_PATTERNS.some(re => re.test(text));

// Stage A (deterministic) + Stage B (semantic classifier for genuinely
// ambiguous input) — see section 7/8 of the guardrail spec this
// implements. Course context: "ignore previous instructions" and similar
// phrases are course material here, so a signal match alone never rejects;
// only a signal combined with a directly-addressed imperative and no
// educational framing does — deterministically for the highest-confidence
// categories, via the LLM classifier for everything else that's ambiguous.
export async function checkPromptInjection(text: string): Promise<InputGuardrailResult> {
  const categories = matchedSignalCategories(text);

  // No signal at all — clearly safe, never touches the classifier.
  if (categories.length === 0) {
    return {
      action: 'ALLOW',
      metadata: { injectionDetectionMethod: 'DETERMINISTIC' satisfies InjectionDetectionMethod, injectionDecision: 'SAFE' },
    };
  }

  const educational = hasEducationalFraming(text);
  const imperative = hasImperativeFraming(text);

  // Clearly educational — a signal matched, but the message reads as a
  // question, quote, or discussion of the technique, not a directive.
  if (educational && !imperative) {
    return {
      action: 'ALLOW',
      metadata: {
        injectionDetectionMethod: 'DETERMINISTIC' satisfies InjectionDetectionMethod,
        injectionDecision: 'EDUCATIONAL_DISCUSSION',
        detectedCategories: categories,
      },
    };
  }

  // Clearly active — a high-confidence category, opened as an imperative
  // directed at the assistant, with no educational framing at all.
  const highConfidence = categories.some(c => HIGH_CONFIDENCE_CATEGORIES.has(c));
  if (highConfidence && imperative && !educational) {
    return {
      action: 'REJECT',
      reason: 'PROMPT_INJECTION',
      metadata: {
        injectionDetectionMethod: 'DETERMINISTIC' satisfies InjectionDetectionMethod,
        injectionDecision: 'ACTIVE_INJECTION',
        detectedCategories: categories,
      },
    };
  }

  // Genuinely ambiguous — hand off to the semantic classifier, if enabled.
  if (!env.LLM.GUARDRAIL.ENABLED) {
    // No classifier available. Fails open (ALLOW) rather than blocking the
    // student — matches every other LLM call site in this codebase
    // (query-router/query-rewriter/rag-answer-memory all fall back to a
    // safe default rather than fail closed), and Stage A already ruled out
    // the high-confidence direct-attack shape above. Flagged plainly for
    // observability so how often this happens stays visible.
    logger.warn('[GUARDRAIL] ⚠️  Prompt-injection classifier disabled — ambiguous input allowed through');
    return {
      action: 'ALLOW',
      metadata: {
        injectionDetectionMethod: 'DETERMINISTIC' satisfies InjectionDetectionMethod,
        injectionDecision: 'SAFE',
        detectedCategories: categories,
        llmFallbackUsed: true,
      },
    };
  }

  const outcome = await classifyPromptInjection(text);
  if (!outcome.ok) {
    logger.warn(`[GUARDRAIL] ⚠️  Falling back to ALLOW after classifier failure (${outcome.failureReason})`);
    return {
      action: 'ALLOW',
      reason: outcome.failureReason,
      metadata: {
        injectionDetectionMethod: 'LLM_CLASSIFIER_FALLBACK' satisfies InjectionDetectionMethod,
        detectedCategories: categories,
        llmFallbackUsed: true,
      },
    };
  }

  const { decision, reason: classifierReason, confidence } = outcome.classification;
  const sharedMetadata = {
    injectionDetectionMethod: 'LLM_CLASSIFIER' satisfies InjectionDetectionMethod,
    injectionDecision: decision,
    detectedCategories: categories,
    classifierConfidence: confidence,
    // Truncated defensively even though the classifier is instructed to
    // return a short, safe-to-log sentence — this guard never trusts LLM
    // output to police its own length before it reaches observability.
    classifierReason: classifierReason.slice(0, 200),
  };

  if (decision === 'ACTIVE_INJECTION') {
    return { action: 'REJECT', reason: 'PROMPT_INJECTION', metadata: sharedMetadata };
  }
  return { action: 'ALLOW', metadata: sharedMetadata };
}
