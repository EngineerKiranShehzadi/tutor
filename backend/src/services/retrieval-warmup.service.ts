import pool from '../config/database';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { EMBEDDING_MODEL_VERSION } from './embedding.service';
import { readWarmupConfig, warmLecture, WarmupCoordinator, WarmupResult } from '../rag/performance/warmup';

// env loads dotenv before these opt-in settings are read.
const config = readWarmupConfig(process.env);
const coordinator = new WarmupCoordinator(config, (id, recent) =>
  warmLecture(pool, config, id, env.RETRIEVAL.EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_VERSION, recent));
export const retrievalWarmupEnabled = config.enabled;
export async function requestRetrievalWarmup(id: number): Promise<WarmupResult> {
  const result = await coordinator.run(id);
  logger.info(`[DB-WARMUP] lecture=${id} status=${result.status} samples=${result.sampleQueries ?? 0} durationMs=${result.durationMs ?? 0}`);
  return result;
}
