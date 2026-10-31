import { query } from '../config/database';
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

// Per-student limits on asking the AI tutor — the most expensive call in the
// app (embedding, rerank and several LLM calls per question). Applied to both
// entry points (GraphQL askLectureAgent and REST /chat/ask-stream) and keyed by
// the authenticated user id, so students behind one campus NAT or proxy do not
// share a bucket.
//
//   burst: at most CHAT.RATE_LIMIT_PER_MINUTE questions in any 60 s (in memory,
//          per process — a short-term brake, not an accounting record)
//   daily: at most CHAT.DAILY_QUESTION_LIMIT questions in the last 24 h,
//          counted from student_questions, so it holds across restarts and
//          across API instances
// 0 disables either limit.

export class AskQuotaExceededError extends AppError {
  constructor(message: string, public retryAfterSec: number) {
    super(message, 429);
    this.name = 'AskQuotaExceededError';
  }
}

const WINDOW_MS = 60_000;
const SWEEP_EVERY_MS = 5 * 60_000;
// user id → start times of their questions in the current window (≤ limit entries)
const recent = new Map<string, number[]>();
let lastSweep = Date.now();

// Drops users with no question in the window, so the map cannot grow without bound.
const sweep = (now: number): void => {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  for (const [id, times] of recent) {
    if (times.length === 0 || now - times[times.length - 1] >= WINDOW_MS) recent.delete(id);
  }
};

export interface AskQuotaLimits { perMinute: number; perDay: number }

const defaultLimits = (): AskQuotaLimits => ({
  perMinute: env.CHAT.RATE_LIMIT_PER_MINUTE,
  perDay: env.CHAT.DAILY_QUESTION_LIMIT,
});

/** Throws AskQuotaExceededError (429) if this student may not ask right now. */
export async function enforceAskQuota(userId: string, limits: AskQuotaLimits = defaultLimits(), now = Date.now()): Promise<void> {
  sweep(now);
  if (limits.perMinute > 0) {
    const times = (recent.get(userId) ?? []).filter(t => now - t < WINDOW_MS);
    if (times.length >= limits.perMinute) {
      recent.set(userId, times);
      const retryAfterSec = Math.max(1, Math.ceil((times[0] + WINDOW_MS - now) / 1000));
      logger.warn(`[ASK QUOTA] 429 burst limit — user=${userId} (${limits.perMinute}/min)`);
      throw new AskQuotaExceededError(
        `You're asking questions very quickly. Please wait ${retryAfterSec} second(s) and try again.`, retryAfterSec);
    }
    // Recorded before the daily check so parallel requests cannot all slip through it.
    times.push(now);
    recent.set(userId, times);
  }
  if (limits.perDay > 0) {
    const { rows } = await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM student_questions
       WHERE student_id = $1 AND created_at > LOCALTIMESTAMP - INTERVAL '24 hours'`,
      [userId]
    );
    if (Number(rows[0]?.n ?? 0) >= limits.perDay) {
      logger.warn(`[ASK QUOTA] 429 daily limit — user=${userId} (${limits.perDay}/24h)`);
      throw new AskQuotaExceededError(
        `You've reached today's limit of ${limits.perDay} questions. Please try again later.`, 3600);
    }
  }
}

/** Tests only. */
export const resetAskQuotaForTests = (): void => { recent.clear(); lastSweep = Date.now(); };
export const askQuotaTrackedUsers = (): number => recent.size;
