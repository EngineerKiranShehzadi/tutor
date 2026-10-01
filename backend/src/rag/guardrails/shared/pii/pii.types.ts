// Single source of truth for PII category labels — used by both the input
// guard (guards/pii-detection.guard.ts) and the output leakage guard
// (output/pii/output-pii-leakage.guard.ts). Never add a category here that
// pii-detector.service.ts doesn't actually detect.
export const PII_CATEGORIES = ['EMAIL', 'PHONE', 'IDENTIFIER', 'IP_ADDRESS', 'CREDIT_CARD'] as const;
export type PiiCategory = typeof PII_CATEGORIES[number];

// pii-detector.service.ts's result contract. The original detected
// value(s) are never part of this shape — only category labels and the
// already-sanitized text, which is the only part of a PII scan that's safe
// to carry into logs/traces/metadata.
export interface PiiScanResult {
  detected: boolean;
  sanitizedText: string;
  detectedCategories: PiiCategory[];
}
