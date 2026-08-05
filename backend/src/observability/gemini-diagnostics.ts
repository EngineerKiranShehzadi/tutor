import { logger } from '../utils/logger';
import { classifyErrorCode } from './tracer';
import type { GeminiOperationType } from './types';

export interface GeminiDiagnostic {
  operationType: GeminiOperationType;
  model: string;
  answerPromptVersion?: string;
  durationMs: number;
  success: boolean;
  errorCode?: string;
  inputTokenCount?: number;
  outputTokenCount?: number;
  validContextSupplied?: boolean;
}

// Structured, safe (no prompt/answer content) diagnostic line for every
// Gemini call in the RAG pipeline. Phase 1 records these as logs; Phase 2
// may additionally persist them once rag_trace_spans exists.
export function logGeminiDiagnostic(diag: GeminiDiagnostic): void {
  const parts = [
    `op=${diag.operationType}`,
    `model=${diag.model}`,
    diag.answerPromptVersion ? `promptVersion=${diag.answerPromptVersion}` : null,
    `durationMs=${diag.durationMs.toFixed(1)}`,
    `success=${diag.success}`,
    diag.inputTokenCount !== undefined ? `inputTokens=${diag.inputTokenCount}` : null,
    diag.outputTokenCount !== undefined ? `outputTokens=${diag.outputTokenCount}` : null,
    diag.validContextSupplied !== undefined ? `validContext=${diag.validContextSupplied}` : null,
    diag.errorCode ? `errorCode=${diag.errorCode}` : null,
  ].filter(Boolean);
  logger.info(`[GEMINI-DIAG] ${parts.join(' ')}`);
}

// Wraps a Gemini call site with timing + safe diagnostic logging without
// changing its return value or error behavior — the original promise's
// resolution/rejection passes through unchanged.
export async function withGeminiDiagnostic<T>(
  meta: Pick<GeminiDiagnostic, 'operationType' | 'model' | 'answerPromptVersion' | 'validContextSupplied'>,
  fn: () => Promise<T>,
  extractTokens?: (result: T) => { input?: number; output?: number }
): Promise<T> {
  const start = process.hrtime.bigint();
  try {
    const result = await fn();
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const tokens = extractTokens?.(result);
    logGeminiDiagnostic({ ...meta, durationMs, success: true, inputTokenCount: tokens?.input, outputTokenCount: tokens?.output });
    return result;
  } catch (err) {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    logGeminiDiagnostic({ ...meta, durationMs, success: false, errorCode: classifyErrorCode(err) });
    throw err;
  }
}
