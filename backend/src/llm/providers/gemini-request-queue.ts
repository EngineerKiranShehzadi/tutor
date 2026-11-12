import { checkAborted } from '../../utils/abortable';
export class GeminiQueueError extends Error {
  constructor(readonly code: 'QUEUE_FULL' | 'QUEUE_TIMEOUT') {
    super(code === 'QUEUE_FULL' ? 'Gemini quiz queue is busy. Please retry shortly.' : 'Gemini quiz queue wait limit reached. Please retry shortly.');
  }
}
type Pending = { enqueuedAt: number; expiresAt: number; signal?: AbortSignal; timer?: ReturnType<typeof setTimeout>;
  cancel: () => void; resolve: (ms: number) => void; reject: (error: unknown) => void };
// Rolling-window, process-local RPM guard. Waiting/cancelled entries do not
// reserve future slots. Multiple backend instances need shared coordination.
export class GeminiRequestQueue {
  private starts: number[] = [];
  private pending: Pending[] = [];
  private wake?: ReturnType<typeof setTimeout>;
  constructor(private readonly limit: () => number, private readonly windowMs = 60_000,
    private readonly now: () => number = () => Date.now()) {}
  acquire(signal?: AbortSignal, maxWaitMs = 65_000): Promise<number> {
    checkAborted(signal);
    const limit = this.limit();
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isFinite(maxWaitMs) || maxWaitMs < 0) throw new Error('Invalid Gemini queue limits');
    if (this.pending.length >= limit * 3) return Promise.reject(new GeminiQueueError('QUEUE_FULL'));
    return new Promise((resolve, reject) => {
      const entry: Pending = { enqueuedAt: this.now(), expiresAt: this.now() + maxWaitMs, signal, resolve, reject,
        cancel: () => this.remove(entry, signal?.reason ?? new Error('Operation cancelled')) };
      this.pending.push(entry);
      signal?.addEventListener('abort', entry.cancel, { once: true });
      entry.timer = setTimeout(() => this.remove(entry, new GeminiQueueError('QUEUE_TIMEOUT')), maxWaitMs);
      this.drain();
    });
  }
  private clean(entry: Pending): void { clearTimeout(entry.timer); entry.signal?.removeEventListener('abort', entry.cancel); }
  private remove(entry: Pending, error: unknown): void {
    const i = this.pending.indexOf(entry);
    if (i < 0) return;
    this.pending.splice(i, 1); this.clean(entry); entry.reject(error); this.drain();
  }
  private drain(): void {
    clearTimeout(this.wake); this.wake = undefined;
    const now = this.now();
    this.starts = this.starts.filter(start => start > now - this.windowMs);
    while (this.pending.length && this.starts.length < this.limit()) {
      const entry = this.pending.shift()!;
      this.clean(entry);
      if (entry.signal?.aborted) entry.reject(entry.signal.reason ?? new Error('Operation cancelled'));
      else if (now > entry.expiresAt) entry.reject(new GeminiQueueError('QUEUE_TIMEOUT'));
      else { this.starts.push(now); entry.resolve(Math.max(0, now - entry.enqueuedAt)); }
    }
    if (this.pending.length && this.starts.length) this.wake = setTimeout(() => this.drain(), Math.max(1, this.starts[0] + this.windowMs - this.now()));
  }
}
