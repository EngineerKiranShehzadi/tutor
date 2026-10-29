// Client-side limiter for Groq's free tier. Pure and clock-injectable so it can be unit-tested.
// It enforces requests/minute and tokens/minute over a sliding 60 s window, tracks a per-process token
// budget, and can be tightened from Groq's own rate-limit response headers.

export interface LimiterConfig { maxRpm: number; maxTpm: number; runTokenBudget: number }

interface Entry { at: number; tokens: number }

export class GroqRateLimiter {
  private window: Entry[] = [];
  private used = 0;
  // Earliest time the next request may start, from a 429/retry-after or a headers hint.
  private blockedUntil = 0;

  constructor(
    private cfg: LimiterConfig,
    private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))
  ) {}

  get tokensUsed(): number { return this.used; }

  private prune(t: number) { this.window = this.window.filter(e => t - e.at < 60_000); }

  // Milliseconds to wait before a request needing `tokens` may start (0 = go now).
  waitMs(tokens: number): number {
    const t = this.now();
    this.prune(t);
    let wait = Math.max(0, this.blockedUntil - t);
    // Walk the window oldest-first until both the request and token ceilings leave room.
    let reqs = this.window.length;
    let toks = this.window.reduce((a, e) => a + e.tokens, 0);
    for (const e of this.window) {
      if (reqs < this.cfg.maxRpm && toks + tokens <= this.cfg.maxTpm) break;
      wait = Math.max(wait, e.at + 60_000 - t);
      reqs -= 1; toks -= e.tokens;
    }
    return wait;
  }

  assertWithinBudget(tokens: number) {
    if (this.used + tokens > this.cfg.runTokenBudget) {
      throw new Error(
        `Groq test token budget exhausted (${this.used} of ${this.cfg.runTokenBudget} tokens used in this process; ` +
        `GROQ_RUN_TOKEN_BUDGET protects the free daily allowance) — restart the process or raise the budget deliberately`
      );
    }
  }

  // Waits until allowed, then books the request with its estimated token cost.
  async acquire(estimatedTokens: number): Promise<Entry> {
    this.assertWithinBudget(estimatedTokens);
    for (;;) {
      const w = this.waitMs(estimatedTokens);
      if (w <= 0) break;
      await this.sleep(w);
    }
    const e = { at: this.now(), tokens: estimatedTokens };
    this.window.push(e);
    return e;
  }

  // Replace the estimate with what the API actually reported.
  settle(entry: Entry, actualTokens: number | undefined) {
    const real = actualTokens ?? entry.tokens;
    entry.tokens = real;
    this.used += real;
  }

  // Groq said "wait this long" (429 retry-after, or exhausted remaining-tokens header).
  blockFor(ms: number) { this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms); }
}

// Parses Groq's duration strings such as "7.66s", "2m59.56s", "1h2m3s", "250ms".
export const parseGroqDuration = (v: string | null | undefined): number | null => {
  if (!v) return null;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0, any = false, m: RegExpExecArray | null;
  while ((m = re.exec(v))) {
    any = true;
    const n = parseFloat(m[1]);
    total += m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60_000 : n * 3_600_000;
  }
  if (!any) { const n = parseFloat(v); return Number.isFinite(n) ? n * 1000 : null; }   // plain seconds (retry-after)
  return Math.ceil(total);
};
