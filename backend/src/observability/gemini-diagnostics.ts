import { logger } from '../utils/logger';
import { classifyErrorCode, getActiveTrace } from './tracer';
import { ATTR } from './otel-semconv';
import { OpenInferenceSpanKind } from './otel-semconv';
import { isContentCaptureEnabled, truncateContent } from './sanitize';
import type { GeminiOperationType, SafeMetadata } from './types';

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

// Structured, safe (no prompt/answer content by default) diagnostic line for
// every Gemini call in the RAG pipeline.
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

export interface GeminiSpanMeta {
  // Name used for the exported child span — see otel-semconv.ts's
  // STAGE_SPAN_KIND map (must be registered there as LLM, or it defaults
  // to CHAIN and Phoenix won't classify it as an LLM call).
  spanName: string;
  operationType: GeminiOperationType;
  model: string;
  provider?: string; // defaults to 'google'
  answerPromptVersion?: string;
  validContextSupplied?: boolean;
  invocationParams?: SafeMetadata; // temperature, maxOutputTokens, etc. — safe, no content
  attempt?: number; // retry attempt number, for spans emitted per-retry
  // Gated by OBSERVABILITY_CAPTURE_CONTENT — a short, truncated preview of
  // the prompt actually sent, never the full prompt/context text.
  promptPreview?: string;
}

// Wraps a Gemini call site: times it, logs a safe diagnostic line (as
// before), AND — when a RequestTrace is active for the current async
// context (see tracer.ts's AsyncLocalStorage-based getActiveTrace()) —
// creates a real nested LLM span under whatever stage span is currently
// active (classify-query-route, rewrite-contextual-query,
// generate-grounded-answer, summarize-lecture-content). This is what makes
// "gemini_router_call" etc. appear as real children in the exported trace
// instead of only ever being a log line.
export async function withGeminiDiagnostic<T>(
  meta: GeminiSpanMeta,
  fn: () => Promise<T>,
  extractTokens?: (result: T) => { input?: number; output?: number; finishReason?: string }
): Promise<T> {
  const trace = getActiveTrace();
  const run = async (): Promise<T> => {
    const start = process.hrtime.bigint();
    try {
      const result = await fn();
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const tokens = extractTokens?.(result);
      logGeminiDiagnostic({
        operationType: meta.operationType, model: meta.model, answerPromptVersion: meta.answerPromptVersion,
        durationMs, success: true, inputTokenCount: tokens?.input, outputTokenCount: tokens?.output,
      });
      return result;
    } catch (err) {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      logGeminiDiagnostic({
        operationType: meta.operationType, model: meta.model, answerPromptVersion: meta.answerPromptVersion,
        durationMs, success: false, errorCode: classifyErrorCode(err),
      });
      throw err;
    }
  };

  if (!trace) return run();

  return trace.span<T>(
    meta.spanName,
    run,
    (result) => {
      const tokens = extractTokens?.(result);
      const promptPreview = isContentCaptureEnabled() && meta.promptPreview
        ? truncateContent(meta.promptPreview, 500).value
        : undefined;
      return {
        [ATTR.LLM_MODEL_NAME]: meta.model,
        [ATTR.LLM_PROVIDER]: meta.provider ?? 'google',
        [ATTR.LLM_SYSTEM]: 'google',
        operationType: meta.operationType,
        answerPromptVersion: meta.answerPromptVersion,
        attempt: meta.attempt,
        validContextSupplied: meta.validContextSupplied,
        [ATTR.LLM_TOKEN_COUNT_PROMPT]: tokens?.input,
        [ATTR.LLM_TOKEN_COUNT_COMPLETION]: tokens?.output,
        [ATTR.LLM_TOKEN_COUNT_TOTAL]: tokens?.input !== undefined && tokens?.output !== undefined ? tokens.input + tokens.output : undefined,
        finishReason: tokens?.finishReason,
        ...(promptPreview !== undefined ? { [ATTR.INPUT_VALUE]: promptPreview } : {}),
        ...(meta.invocationParams ?? {}),
      };
    },
    undefined,
    OpenInferenceSpanKind.LLM
  );
}
