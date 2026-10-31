// A Map whose entries expire and whose size is capped (A20) — for in-process
// caches and counters keyed by something callers control (an IP, a filter
// combination), which a plain Map would keep forever.
//   - get() never returns an expired entry (and drops it);
//   - expired entries are swept at most once per sweepEveryMs, on write;
//   - past maxEntries the oldest-inserted entries are evicted.
export class ExpiringMap<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  private lastSweep = 0;

  constructor(private readonly maxEntries: number, private readonly sweepEveryMs = 60_000) {}

  get(key: string, now = Date.now()): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= now) { this.entries.delete(key); return undefined; }
    return e.value;
  }

  set(key: string, value: V, ttlMs: number, now = Date.now()): void {
    this.entries.delete(key); // re-insert so the newest write is evicted last
    this.entries.set(key, { value, expiresAt: now + ttlMs });
    if (now - this.lastSweep >= this.sweepEveryMs) {
      this.lastSweep = now;
      for (const [k, e] of this.entries) if (e.expiresAt <= now) this.entries.delete(k);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  get size(): number { return this.entries.size; }
  clear(): void { this.entries.clear(); }
}
