import { scanForPii } from '../../shared/pii/pii-detector.service';
import type { InputGuardrailResult } from '../types/input-guardrail.types';

// Input-side PII guard — thin adapter over the shared detector (see
// guardrails/shared/pii/pii-detector.service.ts, the single source of truth
// for detection/sanitization rules, also used by the output PII leakage
// guard). Owns no pattern logic itself. Never rejects, only sanitizes.
export function detectAndSanitizePii(text: string): InputGuardrailResult {
  const scan = scanForPii(text);
  if (!scan.detected) {
    return { action: 'ALLOW' };
  }

  return {
    action: 'SANITIZE',
    reason: 'PII_DETECTED',
    sanitizedInput: scan.sanitizedText,
    metadata: { detectedCategories: scan.detectedCategories },
  };
}
