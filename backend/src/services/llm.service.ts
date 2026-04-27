// ── LLM Service — Steps 1 & 3 of the RAG pipeline ───────────────────────────
// Step 1: parseQuery  — converts raw user message → structured JSON filter
// Step 3: generateResponse — produces grounded answer from real lecture data
//
// Uses Anthropic claude-haiku (fast + cheap) when ANTHROPIC_API_KEY is set.
// Falls back to smart keyword-based mock logic if no key is configured.
// To swap model or provider: update only this file.

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { LectureQueryFilter } from './lecture-search.service';

let _client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  if (!_client) _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}

// ── Step 1: Parse user message → structured query filter ─────────────────────

const PARSE_SYSTEM = `Convert the user's question into a JSON search filter for lecture content.
Return ONLY valid JSON — no explanation, no markdown fences.
Required schema:
{
  "topic": "main subject as a short phrase, or null",
  "keywords": ["array", "of", "important", "terms"],
  "lectureNum": "lecture number 0-6 if mentioned, otherwise null",
  "intent": "explain | example | quiz | summarize | other"
}`;

export async function parseQuery(userMessage: string): Promise<LectureQueryFilter> {
  const client = getClient();
  if (!client) return fallbackParseQuery(userMessage);

  try {
    const resp = await client.messages.create({
      model:       'claude-haiku-4-5-20251001',
      max_tokens:  200,
      temperature: 0.1, // very deterministic — we want consistent JSON
      system:      PARSE_SYSTEM,
      messages:    [{ role: 'user', content: userMessage }],
    });

    const raw = resp.content[0].type === 'text' ? resp.content[0].text.trim() : '{}';
    // Strip any accidental markdown fences
    const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(json);

    return {
      topic:      typeof parsed.topic === 'string' ? parsed.topic : undefined,
      keywords:   Array.isArray(parsed.keywords) ? parsed.keywords.map(String) : [],
      lectureNum: typeof parsed.lectureNum === 'number' ? parsed.lectureNum : null,
      intent:     ['explain', 'example', 'quiz', 'summarize', 'other'].includes(parsed.intent)
                    ? parsed.intent
                    : 'other',
    };
  } catch {
    return fallbackParseQuery(userMessage);
  }
}

// ── Step 3: Generate grounded response using the lecture's agent prompt ───────
// agentSystemPrompt comes directly from LectureKnowledge.agent.systemPrompt —
// each lecture's named agent has its own persona and tone baked in.

export async function generateResponse(
  userMessage:       string,
  dataBlock:         string,
  agentSystemPrompt: string
): Promise<string> {
  const client = getClient();
  if (!client) return fallbackGenerateResponse(dataBlock);

  try {
    const resp = await client.messages.create({
      model:       'claude-haiku-4-5-20251001',
      max_tokens:  300,
      temperature: 0.3, // low = factual, but still reads naturally
      system:      agentSystemPrompt,
      messages: [{
        role:    'user',
        content: `USER QUESTION: ${userMessage}\n\nACTUAL DATA FROM LECTURE CONTENT:\n${dataBlock}\n\nANSWER:`,
      }],
    });

    return resp.content[0].type === 'text' ? resp.content[0].text.trim() : fallbackGenerateResponse(dataBlock);
  } catch {
    return fallbackGenerateResponse(dataBlock);
  }
}

// ── Mock fallbacks (used when ANTHROPIC_API_KEY is not set) ───────────────────

function fallbackParseQuery(userMessage: string): LectureQueryFilter {
  const lower = userMessage.toLowerCase();
  const stopWords = new Set(['what', 'how', 'why', 'when', 'who', 'is', 'are', 'the', 'a', 'an', 'in', 'on', 'for', 'of', 'to', 'me', 'my', 'can', 'do', 'does']);
  const keywords = lower
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9-]/g, ''))
    .filter((w) => w.length > 2 && !stopWords.has(w));

  const intent = lower.includes('example')  ? 'example'
               : lower.includes('quiz')     ? 'quiz'
               : lower.includes('summar')   ? 'summarize'
               : 'explain';

  const lectureMatch = lower.match(/lecture\s*(\d)/);

  return {
    topic:      userMessage.slice(0, 60),
    keywords,
    lectureNum: lectureMatch ? parseInt(lectureMatch[1], 10) : null,
    intent,
  };
}

function fallbackGenerateResponse(dataBlock: string): string {
  if (dataBlock.includes('No matching')) {
    return `I couldn't find specific content matching your question in the available lectures. Try asking about <strong>zero-shot prompts</strong>, <strong>chain-of-thought</strong>, prompt formulation, or other core topics covered in this course.`;
  }

  // Extract first concept definition from the data block for a useful reply
  const match = dataBlock.match(/\n  ([^:]+):\s(.+)/);
  if (match) {
    const [, term, definition] = match;
    return `<strong>${term.trim()}</strong> refers to ${definition.slice(0, 120).trim()}. Ask me a more specific question to explore this topic further!`;
  }

  return `The lecture covers this topic in detail. Try asking something like <strong>"What is zero-shot prompting?"</strong> or <strong>"Give me an example of chain-of-thought"</strong> for a more focused answer.`;
}
