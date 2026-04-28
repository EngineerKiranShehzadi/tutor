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

export const generateAnswer = async (
  question: string,
  chunks: QnaChunk[],
  lectureTitle: string
): Promise<string> => {
  const genAI = getClient();
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
  });

  const context = buildContext(chunks);
  const prompt = `${SYSTEM_PROMPT}

Lecture: "${lectureTitle}"

Lecture Q&A Context:
${context}

Student Question:
${question}`;

  logger.info(`[LLM] 🤖 Sending prompt to Gemini (${chunks.length} chunks, question="${question.slice(0, 60)}...")`);

  const result = await model.generateContent(prompt);
  const answer = result.response.text();

  logger.info(`[LLM] ✅ Gemini answered (${answer.length} chars)`);
  return answer;
};
