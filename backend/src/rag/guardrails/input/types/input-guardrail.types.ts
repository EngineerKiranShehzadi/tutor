import type { InputGuardrailReason } from './input-guardrail-reasons';

export type InputGuardrailAction = 'ALLOW' | 'SANITIZE' | 'REJECT';

// Safe-by-construction metadata bag — same contract as observability's
// SafeMetadata (see observability/types.ts): every value here must be safe
// to log/trace as-is. Guards must put category labels here
// (detectedCategories: ['EMAIL']), never the raw detected value.
export type InputGuardrailMetadata = Record<string, string | number | boolean | string[] | null | undefined>;

export interface InputGuardrailResult {
  action: InputGuardrailAction;
  reason?: InputGuardrailReason;
  // Populated on SANITIZE (and carried through unchanged on ALLOW/REJECT) —
  // the text that should continue into the next guard / the query router.
  sanitizedInput?: string;
  metadata?: InputGuardrailMetadata;
}

// A single guard's contract — every guard under guards/ implements this
// shape (some, like PiiDetectionGuard, are pure sync functions; the
// injection guard's outer function is async because it may call the
// classifier). `input` is always whatever the previous guard already
// produced (raw text for the first guard, sanitized text after PII).
export type InputGuard = (input: string) => InputGuardrailResult | Promise<InputGuardrailResult>;

// ── Prompt injection intent classification (guards/prompt-injection.guard.ts
// and classifiers/prompt-injection-classifier.service.ts) ──────────────────

export type PromptInjectionIntent = 'SAFE' | 'EDUCATIONAL_DISCUSSION' | 'ACTIVE_INJECTION';

// How a PromptInjectionIntent decision was actually reached — surfaced in
// guardrail metadata as guardrail.injection_detection_method so it's clear
// whether a given ALLOW/REJECT came from cheap deterministic rules or an
// LLM call.
export type InjectionDetectionMethod = 'DETERMINISTIC' | 'LLM_CLASSIFIER' | 'LLM_CLASSIFIER_FALLBACK';

export interface PromptInjectionClassification {
  decision: PromptInjectionIntent;
  confidence: number;
  reason: string;
}
