import { GoogleGenAI, Type } from '@google/genai';
import type { Schema } from '@google/genai';
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';

// Every other file in this codebase that talks to Gemini goes through this
// module — none of them import '@google/genai' directly. That's the whole
// point: if the SDK changes again, this file (plus these two re-exports, if
// the new SDK's schema shape differs) is the only thing that needs to
// change. Callers depend on GeminiSchemaType/GeminiSchema/generateContent's
// plain-object shapes below, never on the SDK's own types.
export { Type as GeminiSchemaType };
export type GeminiSchema = Schema;

let client: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  if (!env.GEMINI_API_KEY) {
    throw new AppError('GEMINI_API_KEY is not configured. Please add it to your .env file.', 500);
  }
  if (!client) {
    client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  }
  return client;
}

export interface GeminiGenerateOptions {
  model: string;
  prompt: string;
  systemInstruction?: string;
  temperature?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
  responseSchema?: GeminiSchema;
  // Gemini 2.5 thinking tokens count against maxOutputTokens, so a small
  // structured-output call can burn its whole budget on thinking and return
  // truncated JSON. 0 turns thinking off for that call.
  thinkingBudget?: number;
  // Aborts the underlying HTTP request via AbortSignal.timeout(), the same
  // idiom already used for the local embedding/rerank calls in
  // embedding.service.ts and rerank.service.ts — not a bare Promise.race,
  // so a timed-out call actually stops the in-flight request instead of
  // just abandoning the wait.
  timeoutMs?: number;
}

export interface GeminiGenerateResult {
  text: string;
  finishReason?: string;
  usage: { promptTokens?: number; completionTokens?: number };
}

// Single call shape every service in this codebase uses to reach Gemini.
// Normalizes the SDK's response (a `text` getter, `usageMetadata`,
// `candidates[0].finishReason`) into a plain object so callers never touch
// @google/genai's response shape either — only this file does.
export async function generateContent(opts: GeminiGenerateOptions): Promise<GeminiGenerateResult> {
  const ai = getGeminiClient();

  const config: Record<string, unknown> = {};
  if (opts.systemInstruction !== undefined) config.systemInstruction = opts.systemInstruction;
  if (opts.temperature !== undefined) config.temperature = opts.temperature;
  if (opts.maxOutputTokens !== undefined) config.maxOutputTokens = opts.maxOutputTokens;
  if (opts.responseMimeType !== undefined) config.responseMimeType = opts.responseMimeType;
  if (opts.responseSchema !== undefined) config.responseSchema = opts.responseSchema;
  if (opts.thinkingBudget !== undefined) config.thinkingConfig = { thinkingBudget: opts.thinkingBudget };
  if (opts.timeoutMs !== undefined) config.abortSignal = AbortSignal.timeout(opts.timeoutMs);

  const response = await ai.models.generateContent({
    model: opts.model,
    contents: opts.prompt,
    config,
  });

  return {
    text: response.text ?? '',
    finishReason: response.candidates?.[0]?.finishReason,
    usage: {
      promptTokens: response.usageMetadata?.promptTokenCount,
      completionTokens: response.usageMetadata?.candidatesTokenCount,
    },
  };
}

// Streaming twin of generateContent(): same request shape and the same
// normalized result (full text + finishReason + usage), but each text piece
// is also handed to onDelta as Gemini produces it. Returning the complete
// result keeps callers' retry/diagnostic code identical to the non-streaming
// path.
export async function generateContentStream(
  opts: GeminiGenerateOptions,
  onDelta: (text: string) => void
): Promise<GeminiGenerateResult> {
  const ai = getGeminiClient();

  const config: Record<string, unknown> = {};
  if (opts.systemInstruction !== undefined) config.systemInstruction = opts.systemInstruction;
  if (opts.temperature !== undefined) config.temperature = opts.temperature;
  if (opts.maxOutputTokens !== undefined) config.maxOutputTokens = opts.maxOutputTokens;
  if (opts.timeoutMs !== undefined) config.abortSignal = AbortSignal.timeout(opts.timeoutMs);

  const stream = await ai.models.generateContentStream({
    model: opts.model,
    contents: opts.prompt,
    config,
  });

  let text = '';
  let finishReason: string | undefined;
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;

  for await (const chunk of stream) {
    const piece = chunk.text ?? '';
    if (piece) {
      text += piece;
      onDelta(piece);
    }
    finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
    promptTokens = chunk.usageMetadata?.promptTokenCount ?? promptTokens;
    completionTokens = chunk.usageMetadata?.candidatesTokenCount ?? completionTokens;
  }

  return { text, finishReason, usage: { promptTokens, completionTokens } };
}

// Lightweight connectivity/auth check — validates the API key and network
// path without generating any output (used by the health check endpoint),
// so it doesn't burn generation quota on every liveness probe the way a
// generateContent() call would.
export async function countTokens(model: string, text: string): Promise<number> {
  const ai = getGeminiClient();
  const result = await ai.models.countTokens({ model, contents: text });
  return result.totalTokens ?? 0;
}

// Shared token-count extractor for withGeminiDiagnostic's extractTokens
// callback — every call site was rebuilding this same little object from
// the raw SDK response before; now they all read it off the normalized
// GeminiGenerateResult the same way.
export const extractGeminiUsage = (r: GeminiGenerateResult) => ({
  input: r.usage.promptTokens,
  output: r.usage.completionTokens,
  finishReason: r.finishReason,
});
