import { env } from '../../../../config/env';
import { resolveLlmProvider } from '../../../../llm/llm-provider.resolver';
import { withLlmDiagnostic, extractLlmUsage } from '../../../../llm/llm-observability.service';
import { logger } from '../../../../utils/logger';
import type { ExpectedResponseFormat, ResponseFormatRepairOutcome } from './response-format.types';

// Only reformats an already-grounded answer into the requested structure —
// never re-runs retrieval, never changes factual content, never introduces
// new information. Bounded to exactly one attempt; the caller
// (output-guardrail.service.ts) never loops this. An LLM repair is a rewrite
// nobody has checked, so the caller compares it with the original
// (response-format-repair-check.service.ts) before serving it.

// ── Deterministic path (LIST only) ──────────────────────────────────────
// Handles the common case where the grounded generator already produced an
// enumeration as one prose sentence ("The advantages are: X, Y, and Z.")
// instead of a list. Only reformats punctuation/whitespace the model itself
// already used to delimit the items — it never guesses where item
// boundaries are — so it's safe to apply without an LLM call. Requires at
// least 3 comma/semicolon-separated items so an ordinary two-item sentence
// isn't mistaken for an enumeration; anything it doesn't confidently
// recognize falls through to the LLM repair path below.
const MIN_ITEMS_FOR_DETERMINISTIC_REPAIR = 3;
const ENUMERATION_SENTENCE = /([^.\n]*:)\s*([^.\n]+)\.(\s|$)/;

function splitEnumerationItems(itemsText: string): string[] {
  return itemsText
    .replace(/,?\s+and\s+/i, ', ')
    .split(/[,;]\s*/)
    .map(item => item.trim())
    .filter(Boolean);
}

function attemptDeterministicListRepair(answer: string): string | null {
  const match = ENUMERATION_SENTENCE.exec(answer);
  if (!match) return null;

  const [fullMatch, intro, itemsText] = match;
  const items = splitEnumerationItems(itemsText);
  if (items.length < MIN_ITEMS_FOR_DETERMINISTIC_REPAIR) return null;

  const bulletList = items.map(item => `- ${item}`).join('\n');
  const replacement = `${intro}\n\n${bulletList}`;
  return answer.slice(0, match.index) + replacement + answer.slice(match.index + fullMatch.length);
}

// ── LLM path (LIST fallback, and TABLE — restructuring prose into a table
// genuinely requires a real transformation, not a punctuation-level split)

const FORMAT_REPAIR_SYSTEM_PROMPT = `You are a formatting-only component for a lecture-based AI tutor. You do not have opinions of your own and you never add, remove, or change any factual content — you only reformat an already-correct answer into the exact structure requested.

Rules:
- Preserve every fact, claim, and word of meaning from the original answer.
- Do not introduce any new information, examples, or claims not already present in the original answer.
- Do not remove any supported content.
- Only change structure/formatting — never rewrite for style, tone, or add commentary.
- Never use outside knowledge — the original answer is the only source you have.
- Return only the reformatted answer text — no preamble, no explanation of what changed.`;

function buildFormatRepairUserPrompt(expectedFormat: ExpectedResponseFormat, answer: string): string {
  const instruction = expectedFormat === 'TABLE'
    ? 'Reformat the answer below as a Markdown table (a header row, a separator row of dashes, then one row per item) that presents the same information the answer already contains. Choose the clearest reasonable columns without adding anything new.'
    : 'Reformat the answer below as a Markdown list (using "- " bullets, or "1. " numbered items if the content is inherently sequential/ordered) that presents the same information the answer already contains.';

  return `${instruction}\n\nOriginal answer:\n${answer}`;
}

async function repairWithLlm(expectedFormat: ExpectedResponseFormat, answer: string): Promise<ResponseFormatRepairOutcome> {
  try {
    const provider = resolveLlmProvider(env.LLM.OUTPUT_FORMAT_REPAIR.PROVIDER);
    const model = env.LLM.OUTPUT_FORMAT_REPAIR.MODEL;
    const timeoutMs = env.LLM.OUTPUT_FORMAT_REPAIR.TIMEOUT_MS;

    const result = await withLlmDiagnostic(
      {
        spanName: 'response_format_repair_call',
        operationType: 'FORMAT_REPAIR',
        provider: provider.name,
        model,
        invocationParams: { temperature: env.LLM.OUTPUT_FORMAT_REPAIR.TEMPERATURE, maxOutputTokens: 2048, timeoutMs },
      },
      () => provider.generate({
        model,
        userPrompt: buildFormatRepairUserPrompt(expectedFormat, answer),
        systemPrompt: FORMAT_REPAIR_SYSTEM_PROMPT,
        temperature: env.LLM.OUTPUT_FORMAT_REPAIR.TEMPERATURE,
        maxOutputTokens: 2048,
        thinking: env.LLM.OUTPUT_FORMAT_REPAIR.THINKING,
        timeoutMs,
      }),
      extractLlmUsage
    );

    const repairedAnswer = result.raw?.trim();
    if (!repairedAnswer) {
      logger.warn('[RESPONSE-FORMAT] ⚠️  Format repair call returned an empty answer');
      return { ok: false };
    }
    return { ok: true, repairedAnswer, method: 'LLM' };
  } catch (err) {
    logger.warn(`[RESPONSE-FORMAT] ⚠️  Format repair call failed: ${(err as Error).message}`);
    return { ok: false };
  }
}

// Entry point used by output-guardrail.service.ts. Never throws — a failed
// repair just means the caller keeps the original grounded (but
// unrestructured) answer instead of ever returning empty/broken text.
export async function repairResponseFormat(
  expectedFormat: ExpectedResponseFormat,
  answer: string
): Promise<ResponseFormatRepairOutcome> {
  if (expectedFormat === 'LIST') {
    const deterministic = attemptDeterministicListRepair(answer);
    if (deterministic) return { ok: true, repairedAnswer: deterministic, method: 'DETERMINISTIC' };
  }

  return repairWithLlm(expectedFormat, answer);
}
