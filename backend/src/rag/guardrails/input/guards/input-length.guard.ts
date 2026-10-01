import type { InputGuardrailResult } from '../types/input-guardrail.types';

// Rough, provider-agnostic token estimate (~4 chars/token — the standard
// heuristic for English text absent a real tokenizer). Isolated in its own
// function so swapping in a real per-model tokenizer later is a one-
// function change; nothing else in this guard needs to know how the
// estimate is computed.
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface InputLengthGuardConfig {
  maxChars: number;
  maxTokens: number;
}

// Deliberately application-level limits, independent of whatever context
// window the currently-configured model supports (see env.ts's
// INPUT_GUARDRAIL.MAX_CHARS/MAX_TOKENS doc comment) — a bigger future model
// does not change what this guard allows through.
export function checkInputLength(text: string, config: InputLengthGuardConfig): InputGuardrailResult {
  if (text.length > config.maxChars) {
    return {
      action: 'REJECT',
      reason: 'INPUT_TOO_LONG',
      metadata: { limitType: 'CHARS', charCount: text.length, maxChars: config.maxChars },
    };
  }

  const estimatedTokens = estimateTokenCount(text);
  if (estimatedTokens > config.maxTokens) {
    return {
      action: 'REJECT',
      reason: 'INPUT_TOO_LONG',
      metadata: { limitType: 'TOKENS', estimatedTokens, maxTokens: config.maxTokens },
    };
  }

  return { action: 'ALLOW' };
}
