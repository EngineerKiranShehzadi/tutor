import { AppError } from '../../middleware/errorHandler';
import { env } from '../../config/env';
import { toJsonSchema } from '../json-schema';
import type { LlmRequest, LlmResponse } from '../llm.types';
import type { LlmProvider } from './llm-provider.interface';

type GeminiReply = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  error?: { message?: string; status?: string };
};

const reservedSlots: number[] = [];
const reserveSlot = (): number => {
  const now = Date.now();
  while (reservedSlots.length && reservedSlots[0] <= now - 60_000) reservedSlots.shift();
  const limit = env.LLM.GEMINI.QUIZ_MAX_RPM;
  if (reservedSlots.length >= limit * 3) {
    throw new AppError('Gemini quiz queue is busy. Please retry shortly.', 503);
  }
  const nextIndex = reservedSlots.length - limit;
  const slot = nextIndex >= 0 ? Math.max(now, reservedSlots[nextIndex] + 60_000) : now;
  reservedSlots.push(slot);
  return slot - now;
};

const sleep = (milliseconds: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

export const geminiLlmProvider: LlmProvider = {
  name: 'gemini',
  assertConfigured() {
    if (!env.LLM.GEMINI.API_KEY) throw new AppError('Quiz generation requires GEMINI_API_KEY in backend/.env.', 503);
  },
  async generate(request: LlmRequest): Promise<LlmResponse> {
    geminiLlmProvider.assertConfigured?.();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 60_000);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
      const wait = reserveSlot();
      if (wait) await sleep(wait);
      const response = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' +
          encodeURIComponent(request.model) + ':generateContent',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': env.LLM.GEMINI.API_KEY,
          },
          signal: controller.signal,
          body: JSON.stringify({
            ...(request.systemPrompt ? { systemInstruction: { parts: [{ text: request.systemPrompt }] } } : {}),
            contents: [{ role: 'user', parts: [{ text: request.userPrompt }] }],
            generationConfig: {
              ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
              ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
              ...(request.responseSchema ? {
                responseMimeType: 'application/json',
                responseJsonSchema: toJsonSchema(request.responseSchema),
              } : {}),
              ...(request.model.startsWith('gemini-2.5') && request.thinking === 'off'
                ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
            },
          }),
        }
      );
      if (!response.ok) {
        if (response.status === 503) {
          if (attempt === 0 && !controller.signal.aborted) {
            await sleep(1100 + Math.floor(Math.random() * 400));
            continue;
          }
          throw new AppError('Gemini model is temporarily overloaded (HTTP 503). Please try again shortly.', 503);
        }
        if (response.status === 429) throw new AppError('Gemini quiz rate limit or daily quota reached. Check Google AI Studio limits and try again later.', 503);
        if (response.status === 401 || response.status === 403) throw new AppError('Gemini quiz API key is invalid or does not have access to this model.', 503);
        if (response.status === 404) throw new AppError('Configured Gemini quiz model is not available to this API key.', 503);
        throw new AppError('Gemini quiz generation unavailable (HTTP ' + response.status + ').', 503);
      }
      const payload = await response.json() as GeminiReply;
      const candidate = payload.candidates?.[0];
      if (!candidate) throw new AppError('Gemini returned no quiz response.', 503);
      const text = (candidate.content?.parts ?? []).map(p => p.text ?? '').join('');
      if (!text && candidate.finishReason !== 'MAX_TOKENS') {
        throw new AppError('Gemini returned an empty or blocked quiz response.', 503);
      }
      return {
        provider: 'gemini', model: request.model, raw: text,
        finishReason: candidate.finishReason === 'MAX_TOKENS' ? 'MAX_TOKENS' : candidate.finishReason,
        usage: {
          inputTokens: payload.usageMetadata?.promptTokenCount,
          outputTokens: payload.usageMetadata?.candidatesTokenCount,
          totalTokens: payload.usageMetadata?.totalTokenCount,
        },
      };
      }
      throw new AppError('Gemini quiz request failed after retry.', 503);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('Gemini quiz request timed out or the network is unavailable.', 503);
    } finally {
      clearTimeout(timer);
    }
  },
};
