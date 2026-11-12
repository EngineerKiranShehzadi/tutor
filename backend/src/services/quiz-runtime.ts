import { randomUUID } from 'crypto';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { checkAborted, waitWithSignal } from '../utils/abortable';

export function quizSetting(name: string, fallback: number, max: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1 || n > max) throw new AppError(`Invalid quiz setting: ${name}.`, 500);
  return n;
}
export class QuizDeadlineError extends AppError {
  readonly code = 'QUIZ_DEADLINE';
  constructor() { super('Quiz generation exceeded its time limit. Please try again; fewer lectures may help.', 503); }
}
export class QuizRun {
  readonly id = randomUUID();
  readonly controller = new AbortController();
  readonly startedAt = performance.now();
  readonly timings: Record<string, number> = {};
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(timeoutMs = quizSetting('QUIZ_GENERATION_TIMEOUT_MS', 120_000, 600_000)) {
    this.timer = setTimeout(() => this.cancel(new QuizDeadlineError()), timeoutMs);
  }
  get signal(): AbortSignal { return this.controller.signal; }
  check(): void { checkAborted(this.signal); }
  cancel(reason: unknown): void { if (!this.signal.aborted) this.controller.abort(reason); }
  dispose(): void { clearTimeout(this.timer); }
  async measure<T>(stage: string, work: () => Promise<T>): Promise<T> {
    this.check();
    const start = performance.now();
    let ok = false;
    try { const value = await waitWithSignal(work(), this.signal); this.check(); ok = true; return value; }
    finally {
      const ms = Math.round(performance.now() - start);
      this.timings[stage] = (this.timings[stage] ?? 0) + ms;
      logger.info(`[QUIZ-STAGE] request=${this.id} stage=${stage} durationMs=${ms} success=${ok}`);
    }
  }
}
