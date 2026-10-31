import { logger } from '../utils/logger';
import { classifyErrorCode, getActiveTrace } from '../observability/tracer';
import { ATTR, OpenInferenceSpanKind } from '../observability/otel-semconv';
import { isContentCaptureEnabled, truncateContent } from '../observability/sanitize';
import type { SafeMetadata } from '../observability/types';
import type { LlmOperationType, LlmResponse } from './llm.types';

// The one span/log wrapper every LLM-dependent service call goes through
// (span/log mechanics reused from tracer.ts/otel-semconv.ts/sanitize.ts).
// llm.provider/llm.model come from the actual resolved provider+model.

export interface LlmDiagnostic {
  operationType: LlmOperationType;
  provider: string;
  model: string;
  answerPromptVersion?: string;
  durationMs: number;
  success: boolean;
  errorCode?: string;
  inputTokenCount?: number;
  outputTokenCount?: number;
  validContextSupplied?: boolean;
}

export function logLlmDiagnostic(diag: LlmDiagnostic): void {
  const parts = [
    `op=${diag.operationType}`,
    `provider=${diag.provider}`,
    `model=${diag.model}`,
    diag.answerPromptVersion ? `promptVersion=${diag.answerPromptVersion}` : null,
    `durationMs=${diag.durationMs.toFixed(1)}`,
    `success=${diag.success}`,
    diag.inputTokenCount !== undefined ? `inputTokens=${diag.inputTokenCount}` : null,
    diag.outputTokenCount !== undefined ? `outputTokens=${diag.outputTokenCount}` : null,
    diag.validContextSupplied !== undefined ? `validContext=${diag.validContextSupplied}` : null,
    diag.errorCode ? `errorCode=${diag.errorCode}` : null,
  ].filter(Boolean);
  logger.info(`[LLM-DIAG] ${parts.join(' ')}`);
}

export interface LlmSpanMeta {
  // Must be registered in otel-semconv.ts's STAGE_SPAN_KIND as LLM, or it
  // defaults to CHAIN and Phoenix won't classify it as an LLM call.
  spanName: string;
  operationType: LlmOperationType;
  provider: string;
  model: string;
  answerPromptVersion?: string;
  validContextSupplied?: boolean;
  invocationParams?: SafeMetadata;
  attempt?: number;
  // Gated by OBSERVABILITY_CAPTURE_CONTENT — a short, truncated preview of
  // the prompt actually sent, never the full prompt/context text.
  promptPreview?: string;
}

// Shared token-count extractor — every LLM call site reads usage off the
// normalized LlmResponse the same way instead of rebuilding this object.
export const extractLlmUsage = (r: LlmResponse) => ({
  input: r.usage?.inputTokens,
  output: r.usage?.outputTokens,
  finishReason: r.finishReason,
});

// Times an LLM call, logs a safe diagnostic line, and — when a RequestTrace
// is active for the current async context — creates a real nested LLM span
// under whichever stage span is currently executing.
export async function withLlmDiagnostic<T>(
  meta: LlmSpanMeta,
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
      logLlmDiagnostic({
        operationType: meta.operationType, provider: meta.provider, model: meta.model,
        answerPromptVersion: meta.answerPromptVersion,
        durationMs, success: true, inputTokenCount: tokens?.input, outputTokenCount: tokens?.output,
      });
      return result;
    } catch (err) {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      logLlmDiagnostic({
        operationType: meta.operationType, provider: meta.provider, model: meta.model,
        answerPromptVersion: meta.answerPromptVersion,
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
        [ATTR.LLM_PROVIDER]: meta.provider,
        [ATTR.LLM_SYSTEM]: meta.provider,
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
