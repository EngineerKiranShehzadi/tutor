import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';
import { QnaChunk } from '../types';
import { logger } from '../utils/logger';

let client: GoogleGenerativeAI | null = null;

export interface ConversationTurn {
  question: string;
  answer:   string;
}

function getClient(): GoogleGenerativeAI {
  if (!env.GEMINI_API_KEY) {
    throw new AppError('GEMINI_API_KEY is not configured. Please add it to your .env file.', 500);
  }
  if (!client) {
    client = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  }
  return client;
}

function buildContext(chunks: QnaChunk[]): string {
  return chunks
    .map((c, i) => {
      const timestamp = c.start_time ? `Timestamp: ${c.start_time} - ${c.end_time ?? ''}` : '';
      return `[Source ${i + 1}]
Topic: ${c.topic ?? 'General'}
Q: ${c.question}
A: ${c.answer}
${timestamp}`.trim();
    })
    .join('\n\n');
}

function buildHistoryBlock(turns: ConversationTurn[]): string {
  if (turns.length === 0) return '';
  const lines = turns.flatMap(t => [`Student: ${t.question}`, `AI Tutor: ${t.answer}`]);
  return `Conversation history (for context only — do not repeat unless directly relevant):\n${lines.join('\n')}\n`;
}

const SYSTEM_PROMPT = `You are a lecture-specific AI tutor for the course "Master Prompt Engineering with ChatGPT".
Answer the student's question using ONLY the provided lecture Q&A context.

Rules:
1. Use ONLY the provided context. Do NOT use outside knowledge.
2. If the answer is not in the context, respond: "I could not find this information in the selected lecture."
3. Explain in simple, student-friendly language.
4. Do NOT invent or guess information not present in the context.
5. If a timestamp is available, mention it so the student can revisit that part of the lecture.
6. Keep answers concise and educational.
7. If the student asks a follow-up (e.g. "can you explain more?"), use the conversation history to understand what they are referring to.`;

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

export const generateAnswer = async (
  question: string,
  chunks: QnaChunk[],
  lectureTitle: string,
  history: ConversationTurn[] = [],
  attempt = 1
): Promise<string> => {
  const genAI = getClient();
  // Fall back to stable 1.5-flash after 2 failed attempts on 2.5-flash
  const modelName = attempt <= 2 ? 'gemini-2.5-flash' : 'gemini-1.5-flash';
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 8192,
      ...(modelName === 'gemini-2.5-flash'
        ? { thinkingConfig: { thinkingBudget: 0 } } // @ts-ignore — not yet typed in SDK
        : {}),
    },
  });

  const context     = buildContext(chunks);
  const historyBlock = buildHistoryBlock(history);
  const prompt = `${SYSTEM_PROMPT}

Lecture: "${lectureTitle}"

Lecture Q&A Context:
${context}
${historyBlock ? `\n${historyBlock}` : ''}
Current Student Question:
${question}`;

  logger.info(`[LLM] 🤖 Sending prompt to Gemini (${chunks.length} chunks, question="${question.slice(0, 60)}...")`);

  try {
    const result = await model.generateContent(prompt);
    const finishReason = result.response.candidates?.[0]?.finishReason;

    if (finishReason === 'MAX_TOKENS') {
      logger.warn('[LLM] ⚠️  Response hit MAX_TOKENS — answer may be truncated');
    }

    const answer = result.response.text();
    if (!answer?.trim()) {
      throw new AppError('Empty response from AI model', 500);
    }

    logger.info(`[LLM] ✅ Gemini answered (${answer.length} chars, finish=${finishReason})`);
    return answer;
  } catch (err: unknown) {
    const msg = String((err as Error).message ?? '');
    const isRateLimit  = msg.includes('429') || msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('resource_exhausted');
    const isOverloaded = msg.includes('503') || msg.toLowerCase().includes('service unavailable') || msg.toLowerCase().includes('high demand');

    if ((isRateLimit || isOverloaded) && attempt <= 3) {
      const wait = Math.pow(2, attempt) * 3000; // 6s, 12s, 24s
      const fallbackNote = attempt >= 2 ? ' (switching to gemini-1.5-flash)' : '';
      logger.warn(`[LLM] Transient error on attempt ${attempt}/3${fallbackNote} — retrying in ${wait / 1000}s...`);
      await sleep(wait);
      return generateAnswer(question, chunks, lectureTitle, history, attempt + 1);
    }

    if (err instanceof AppError) throw err;
    logger.error('[LLM] ❌ Gemini error:', err);
    throw new AppError('AI model failed to generate a response. Please try again.', 500);
  }
};
