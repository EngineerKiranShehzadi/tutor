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

// Returns a 3072-dimensional embedding vector (gemini-embedding-001)
export const generateEmbedding = async (text: string): Promise<number[]> => {
  const genAI = getClient();
  const model = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });

  const result = await model.embedContent(text);
  const embedding = result.embedding.values;

  logger.info(`[EMBEDDING] Generated vector of length ${embedding.length} for text: "${text.slice(0, 60)}..."`);
  return embedding;
};
