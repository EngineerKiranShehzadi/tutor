'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import api from '@/lib/api';

const recent = new Map<string, number>();
const running = new Set<string>();
/** Optional speculative request; never blocks chat, generates answers or polls. */
export function LectureRetrievalWarmup({ userId }: { userId: string }) {
  const pathname = usePathname();
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_RAG_DB_WARMUP_ENABLED !== 'true') return;
    const match = /^\/lecture\/([1-9]\d*)\/?$/.exec(pathname ?? '');
    if (!match) return;
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || id > 2147483647) return;
    const key = `${userId}:${id}`, controller = new AbortController();
    const timer = setTimeout(() => {
      if (document.visibilityState === 'hidden' || running.has(key) || (recent.get(key) ?? 0) > Date.now()) return;
      running.add(key);
      void api.post('/chat/retrieval-warmup', { lectureId: id }, { signal: controller.signal, timeout: 22000 })
        .then(({ data }) => {
          if (data?.status === 'SAMPLED_WARMUP_COMPLETE' || data?.status === 'COOLDOWN') {
            for (const [k, expiry] of recent) if (expiry <= Date.now()) recent.delete(k);
            recent.set(key, Date.now() + 60000);
            while (recent.size > 64) recent.delete(recent.keys().next().value!);
          }
        }).catch(() => { /* Best effort; no blocking error UI or automatic retry. */ })
        .finally(() => { running.delete(key); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [pathname, userId]);
  return null;
}
