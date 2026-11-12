// A bounded, retryable, per-session read cache. It never runs mutations.
export function createPrefetchGate(ttlMs = 30_000, limit = 64, now = Date.now) {
  const recent = new Map<string, number>();
  const pending = new Map<string, Promise<void>>();
  let generation = 0;
  return {
    run(key: string, work: () => Promise<unknown>): Promise<void> {
      const existing = pending.get(key);
      if (existing) return existing;
      const time = now();
      for (const [id, expiry] of recent) if (expiry <= time) recent.delete(id);
      if ((recent.get(key) ?? 0) > time) return Promise.resolve();
      if (pending.size >= limit) return Promise.resolve();
      const started = generation;
      const job = Promise.resolve().then(work).then(() => {
        if (started !== generation) return;
        while (recent.size >= limit) recent.delete(recent.keys().next().value!);
        recent.set(key, now() + ttlMs);
      }).catch(() => {
        // Speculative reads may fail. The page owns visible errors and retry.
      }).finally(() => { if (pending.get(key) === job) pending.delete(key); });
      pending.set(key, job);
      return job;
    },
    clear() { generation++; recent.clear(); pending.clear(); },
  };
}
export function studentDestination(href: string, origin: string): { path: string; lectureId?: string } | null {
  try {
    const url = new URL(href, origin);
    if (url.origin !== origin) return null;
    const path = url.pathname.replace(/\/$/, '') || '/';
    if (['/courses', '/lectures', '/practice', '/profile', '/profile/activity'].includes(path)) return { path };
    const lecture = path.match(/^\/lecture\/([1-9]\d*)$/);
    return lecture ? { path, lectureId: lecture[1] } : null;
  } catch { return null; }
}
