import { AppError } from '../../middleware/errorHandler';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { abortableSleep, checkAborted } from '../../utils/abortable';
import { quizSetting } from '../../services/quiz-runtime';
import { toJsonSchema } from '../json-schema';
import type { LlmRequest, LlmResponse } from '../llm.types';
import type { LlmProvider } from './llm-provider.interface';
import { GeminiQueueError, GeminiRequestQueue } from './gemini-request-queue';

type GeminiReply = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
};
export class GeminiQuizError extends AppError {
  constructor(readonly code: string, message: string) { super(message, 503); }
}
const queue = new GeminiRequestQueue(() => env.LLM.GEMINI.QUIZ_MAX_RPM);
const safeTag = (s?: string) => (s ?? '-').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 80);

// Inject queue/fetch in offline tests, not keys or quota from another account.
export function createGeminiLlmProvider(deps: {
  queue?: Pick<GeminiRequestQueue, 'acquire'>; fetch?: typeof fetch; retryDelayMs?: number;
} = {}): LlmProvider {
  return {
    name: 'gemini',
    assertConfigured() {
      if (!env.LLM.GEMINI.API_KEY) throw new AppError('Quiz generation requires GEMINI_API_KEY in backend/.env.', 503);
    },
    async generate(request: LlmRequest): Promise<LlmResponse> {
      if (!env.LLM.GEMINI.API_KEY) throw new AppError('Quiz generation requires GEMINI_API_KEY in backend/.env.', 503);
      for (let attempt = 0; attempt < 2; attempt++) {
        checkAborted(request.signal);
        let phase = 'QUEUE', outcome = 'SUCCESS';
        let queueMs = 0, apiStarted = 0;
        let networkExpired = false;
        let httpStatus: number | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const controller = new AbortController();
        const relay = () => controller.abort(request.signal?.reason);
        const started = performance.now();
        try {
          // HTTP deadline starts AFTER admission. Parent quiz deadline includes
          // queue, HTTP, retries, verification and repair; queue waits can abort.
          queueMs = await (deps.queue ?? queue).acquire(request.signal,
            quizSetting('GEMINI_QUIZ_QUEUE_TIMEOUT_MS', 65_000, 120_000));
          checkAborted(request.signal);
          request.signal?.addEventListener('abort', relay, { once: true });
          timer = setTimeout(() => { networkExpired = true; controller.abort(); }, request.timeoutMs ?? 60_000);
          phase = 'NETWORK'; apiStarted = performance.now();
          const response = await (deps.fetch ?? globalThis.fetch)(
            'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(request.model) + ':generateContent', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.LLM.GEMINI.API_KEY },
              signal: controller.signal,
              body: JSON.stringify({
                ...(request.systemPrompt ? { systemInstruction: { parts: [{ text: request.systemPrompt }] } } : {}),
                contents: [{ role: 'user', parts: [{ text: request.userPrompt }] }],
                generationConfig: {
                  ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
                  ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
                  ...(request.responseSchema ? { responseMimeType: 'application/json', responseJsonSchema: toJsonSchema(request.responseSchema) } : {}),
                  ...(request.model.startsWith('gemini-2.5') && request.thinking === 'off' ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
                },
              }),
            });
          httpStatus = response.status;
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            if (response.status === 503) throw new GeminiQuizError('MODEL_OVERLOADED', 'Gemini model is temporarily overloaded (HTTP 503). Please try again shortly.');
            if (response.status === 429) throw new GeminiQuizError('RATE_LIMIT', 'Gemini quiz rate limit or daily quota reached. Check Google AI Studio limits and try again later.');
            if (response.status === 401 || response.status === 403) throw new GeminiQuizError('MODEL_ACCESS', 'Gemini quiz API key is invalid or does not have access to this model.');
            if (response.status === 404) throw new GeminiQuizError('MODEL_NOT_FOUND', 'Configured Gemini quiz model is not available to this API key.');
            throw new GeminiQuizError('HTTP_ERROR', 'Gemini quiz generation unavailable (HTTP ' + response.status + ').');
          }
          phase = 'RESPONSE';
          const payload = await response.json() as GeminiReply;
          checkAborted(request.signal);
          if (networkExpired) throw new Error('Response deadline expired');
          const candidate = payload?.candidates?.[0];
          if (!candidate) throw new GeminiQuizError('EMPTY_RESPONSE', 'Gemini returned no quiz response.');
          const text = (candidate.content?.parts ?? []).filter(p => !p.thought).map(p => p.text ?? '').join('');
          if (!text && candidate.finishReason !== 'MAX_TOKENS') throw new GeminiQuizError('EMPTY_RESPONSE', 'Gemini returned an empty or blocked quiz response.');
          return { provider: 'gemini', model: request.model, raw: text, finishReason: candidate.finishReason,
            usage: { inputTokens: payload.usageMetadata?.promptTokenCount, outputTokens: payload.usageMetadata?.candidatesTokenCount, totalTokens: payload.usageMetadata?.totalTokenCount } };
        } catch (error) {
          let reported: unknown = error;
          if (request.signal?.aborted) { outcome = 'CANCELLED'; reported = request.signal.reason ?? new GeminiQuizError(outcome, 'Quiz generation was cancelled.'); }
          else if (networkExpired) { outcome = 'MODEL_TIMEOUT'; reported = new GeminiQuizError(outcome, 'Gemini did not finish the quiz request within its response time limit. Please retry.'); }
          else if (error instanceof GeminiQueueError) { outcome = error.code; reported = new GeminiQuizError(error.code, error.message); }
          else if (error instanceof GeminiQuizError) outcome = error.code;
          else if (!(error instanceof AppError)) {
            outcome = phase === 'RESPONSE' ? 'INVALID_RESPONSE' : 'NETWORK_FAILURE';
            reported = new GeminiQuizError(outcome, phase === 'RESPONSE' ? 'Gemini returned an unreadable quiz response. Please retry.' : 'Could not reach Gemini. Check the backend network connection and retry.');
          } else outcome = 'CONFIGURATION_ERROR';
          if (!(reported instanceof GeminiQuizError && reported.code === 'MODEL_OVERLOADED' && attempt === 0)) throw reported;
        } finally {
          clearTimeout(timer); request.signal?.removeEventListener('abort', relay);
          const elapsed = Math.round(performance.now() - started);
          logger.info(`[QUIZ-LLM] request=${safeTag(request.telemetry?.requestId)} operation=${safeTag(request.telemetry?.operation)} model=${safeTag(request.model)} attempt=${attempt + 1} queueMs=${Math.round(apiStarted ? queueMs : elapsed)} apiMs=${apiStarted ? Math.round(performance.now() - apiStarted) : 0} outcome=${outcome} http=${httpStatus ?? '-'}`);
        }
        // Retry overload once; no blind retries for quota/access/network/timeout.
        await abortableSleep(deps.retryDelayMs ?? 1250, request.signal);
      }
      throw new GeminiQuizError('RETRY_EXHAUSTED', 'Gemini quiz request failed after retry.');
    },
  };
}
export const geminiLlmProvider = createGeminiLlmProvider();
