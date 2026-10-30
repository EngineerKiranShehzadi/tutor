import { GeminiSchemaType, type GeminiSchema, generateContent, generateContentStream, type GeminiGenerateResult } from '../../services/gemini-provider.service';
import { toGeminiThinkingConfig } from './gemini-thinking';
import type { LlmProvider } from './llm-provider.interface';
import type { LlmRequest, LlmResponse, LlmSchema } from '../llm.types';

// The only file in the codebase that maps the provider-neutral LlmSchema
// onto @google/genai's Schema/Type shape — every LLM-dependent service
// builds an LlmSchema and never touches GeminiSchemaType directly.
function toGeminiSchema(schema: LlmSchema): GeminiSchema {
  const typeMap: Record<LlmSchema['type'], GeminiSchema['type']> = {
    STRING:  GeminiSchemaType.STRING,
    NUMBER:  GeminiSchemaType.NUMBER,
    BOOLEAN: GeminiSchemaType.BOOLEAN,
    OBJECT:  GeminiSchemaType.OBJECT,
    ARRAY:   GeminiSchemaType.ARRAY,
  };

  const out: GeminiSchema = { type: typeMap[schema.type] };
  if (schema.description !== undefined) out.description = schema.description;
  if (schema.enum !== undefined) { out.format = 'enum'; out.enum = schema.enum; }
  if (schema.items !== undefined) out.items = toGeminiSchema(schema.items);
  if (schema.properties !== undefined) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)])
    );
  }
  if (schema.required !== undefined) out.required = schema.required;
  return out;
}

// Thin adapter over the existing gemini-provider.service.ts wrapper — it
// still owns the actual @google/genai client, request shape, and response
// normalization (text/finishReason/usageMetadata). This file only
// translates between the provider-neutral contract and that wrapper's
// existing GeminiGenerateOptions/GeminiGenerateResult shapes; it duplicates
// none of that logic.
const toLlmResponse = (result: GeminiGenerateResult, model: string): LlmResponse => ({
  raw: result.text,
  provider: 'gemini',
  model,
  finishReason: result.finishReason,
  usage: {
    inputTokens: result.usage.promptTokens,
    outputTokens: result.usage.completionTokens,
    totalTokens:
      result.usage.promptTokens !== undefined && result.usage.completionTokens !== undefined
        ? result.usage.promptTokens + result.usage.completionTokens
        : undefined,
  },
});

export const geminiLlmProvider: LlmProvider = {
  name: 'gemini',

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const result = await generateContent({
      model: request.model,
      prompt: request.userPrompt,
      systemInstruction: request.systemPrompt,
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
      thinkingConfig: toGeminiThinkingConfig(request.model, request.thinking),
      timeoutMs: request.timeoutMs,
      // Gemini requires responseMimeType alongside responseSchema for
      // structured output — callers only ever specify the schema, this
      // adapter is responsible for the Gemini-specific plumbing that makes
      // it actually take effect.
      ...(request.responseSchema !== undefined
        ? { responseMimeType: 'application/json', responseSchema: toGeminiSchema(request.responseSchema) }
        : {}),
    });
    return toLlmResponse(result, request.model);
  },

  // Plain-text streaming only — structured (JSON-schema) output is never
  // streamed, so responseSchema is intentionally not forwarded here (thinking
  // is: the streamed grounded answer is the task with the largest thinking
  // spend).
  async generateStream(request: LlmRequest, onDelta: (text: string) => void): Promise<LlmResponse> {
    const result = await generateContentStream({
      model: request.model,
      prompt: request.userPrompt,
      systemInstruction: request.systemPrompt,
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
      thinkingConfig: toGeminiThinkingConfig(request.model, request.thinking),
      timeoutMs: request.timeoutMs,
    }, onDelta);
    return toLlmResponse(result, request.model);
  },
};
