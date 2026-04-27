// ── RAG Pipeline Orchestrator ─────────────────────────────────────────────────
// Implements the full 3-step pattern with per-lecture agent routing:
//   Step 1 → LLM extracts structured query from user message
//   Step 2 → Search lecture knowledge base using that query
//   Step 3 → Lecture's named agent generates grounded response from real results

import { parseQuery, generateResponse }                    from './llm.service';
import { searchLectures, getLectureById, serializeResults } from './lecture-search.service';

export interface RagChatResponse {
  explanation: string;
  agentName:   string;
  sources:     { id: string; title: string }[];
}

// Fallback agent for unknown lectureIds
const DEFAULT_AGENT = {
  name:         'Tutor',
  systemPrompt: 'You are an AI tutor for a Prompt Engineering course. ' +
                'Use ONLY the facts in ACTUAL DATA below. Write 2-3 sentences. ' +
                'Conversational tone. Use <strong> tags on 1-2 key terms.',
};

export async function handleChatMessage(
  lectureId:   string,
  userMessage: string
): Promise<RagChatResponse> {
  // Resolve the lecture's dedicated agent
  const lecture = getLectureById(lectureId);
  const agent   = lecture?.agent ?? DEFAULT_AGENT;

  // ── Step 1: LLM converts natural language → structured filter ────────────
  const filter = await parseQuery(userMessage);

  // ── Step 2: Search lecture knowledge base using the filter ───────────────
  const results   = searchLectures(filter, lectureId);
  const dataBlock = serializeResults(results);

  // ── Step 3: Lecture's named agent generates grounded answer ─────────────
  const explanation = await generateResponse(userMessage, dataBlock, agent.systemPrompt);

  return {
    explanation,
    agentName: agent.name,
    sources:   results.map((r) => ({ id: r.id, title: r.title })),
  };
}
