import { scanForPii } from '../../shared/pii/pii-detector.service';
import type { PiiCategory } from '../../shared/pii/pii.types';

// Never includes the actual detected value(s) anywhere — only category
// labels, same contract as the shared detector and the input guard.
export interface OutputPiiGuardResult {
  piiDetected: boolean;
  sanitizedAnswer: string;
  detectedCategories: PiiCategory[];
}

// Output-side counterpart to the input PII guard — separate concern, same
// rules. Input PII protection (input/guards/pii-detection.guard.ts) keeps
// sensitive values the student typed from flowing into the RAG pipeline;
// this guard keeps sensitive values from being exposed in the final
// generated answer. Both call the same shared detector
// (guardrails/shared/pii/pii-detector.service.ts) — this file owns no
// pattern logic of its own.
//
// Must be called on the actual final answer text — after groundedness
// verification/revision and after any format repair — since any
// model-generated transformation could in principle introduce
// sensitive-looking content. Prefers sanitizing over rejecting: an
// otherwise valid, grounded answer keeps its value with the sensitive
// span replaced by a placeholder rather than being discarded.
export function detectOutputPiiLeakage(answer: string): OutputPiiGuardResult {
  const scan = scanForPii(answer);
  return {
    piiDetected: scan.detected,
    sanitizedAnswer: scan.sanitizedText,
    detectedCategories: scan.detectedCategories,
  };
}
