import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';
import { QnaChunk } from '../types';
import { logger } from '../utils/logger';

let client: GoogleGenerativeAI | null = null;

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

const SYSTEM_PROMPT = `You are a lecture-specific AI tutor for the course "Master Prompt Engineering with ChatGPT".
Answer the student's question using ONLY the provided lecture Q&A context.

Rules:
1. Use ONLY the provided context. Do NOT use outside knowledge.
2. If the answer is not in the context, respond: "I could not find this information in the selected lecture."
3. Explain in simple, student-friendly language.
4. Do NOT invent or guess information not present in the context.
5. If a timestamp is available, mention it so the student can revisit that part of the lecture.
6. Keep answers concise and educational.`;

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

export const generateAnswer = async (
  question: string,
  chunks: QnaChunk[],
  lectureTitle: string,
  attempt = 1
): Promise<string> => {
  const genAI = getClient();
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 8192,
      // @ts-ignore — thinkingConfig is supported but not yet typed in this SDK version
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const context = buildContext(chunks);
  const prompt = `${SYSTEM_PROMPT}

Lecture: "${lectureTitle}"

Lecture Q&A Context:
${context}

Student Question:
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
    const isRateLimit = msg.includes('429') || msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('resource_exhausted');

    if (isRateLimit && attempt <= 3) {
      const wait = Math.pow(2, attempt) * 3000; // 6s, 12s, 24s
      logger.warn(`[LLM] Rate limit hit (attempt ${attempt}/3) — retrying in ${wait / 1000}s...`);
      await sleep(wait);
      return generateAnswer(question, chunks, lectureTitle, attempt + 1);
    }

    if (err instanceof AppError) throw err;
    logger.error('[LLM] ❌ Gemini error:', err);
    throw new AppError('AI model failed to generate a response. Please try again.', 500);
  }
};
