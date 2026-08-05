'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import type { AutoRefreshInterval } from './ObservabilityHeader';

// Shared auto-refresh timer for observability pages: pauses while the tab
// is hidden (visibilitychange) so a backgrounded admin tab doesn't keep
// hitting Phoenix, and always cleans up its interval on unmount/interval
// change so there's never a leaked timer.
export function useAutoRefresh(callback: () => void) {
  const [interval, setInterval_] = useState<AutoRefreshInterval>(0);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const refresh = useCallback(() => {
    callbackRef.current();
    setLastRefreshedAt(new Date());
  }, []);

  useEffect(() => {
    if (!interval) return;
    let timer: number | null = null;

    const start = () => { timer = window.setInterval(() => callbackRef.current(), interval) as unknown as number; };
    const stop = () => { if (timer !== null) { window.clearInterval(timer); timer = null; } };

    const onVisibility = () => { document.hidden ? stop() : start(); };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [interval]);

  return { autoRefresh: interval, setAutoRefresh: setInterval_, refresh, lastRefreshedAt, setLastRefreshedAt };
}
