import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

let client: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  if (!env.GEMINI_API_KEY) {
    throw new AppError('GEMINI_API_KEY is not configured. Please add it to your .env file.', 500);
  }
  if (!client) {
    client = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    logger.info('[EMBEDDING] ✅ Gemini client initialised');
  }
  return client;
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

// Returns a 3072-dimensional embedding vector (gemini-embedding-001)
// Retries up to 4 times on 429 rate-limit errors with exponential backoff
export const generateEmbedding = async (text: string, attempt = 1): Promise<number[]> => {
  const genAI = getClient();
  const model = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });

  try {
    const result = await model.embedContent(text);
    const embedding = result.embedding.values;
    logger.info(`[EMBEDDING] Generated vector of length ${embedding.length} for text: "${text.slice(0, 60)}..."`);
    return embedding;
  } catch (err: unknown) {
    const msg = String((err as Error).message ?? '');
    const isRateLimit = msg.includes('429') || msg.toLowerCase().includes('quota');

    if (isRateLimit && attempt <= 4) {
      const wait = Math.pow(2, attempt) * 5000; // 10s, 20s, 40s, 80s
      logger.warn(`[EMBEDDING] Rate limit hit (attempt ${attempt}/4) — retrying in ${wait / 1000}s...`);
      await sleep(wait);
      return generateEmbedding(text, attempt + 1);
    }
    throw err;
  }
};
