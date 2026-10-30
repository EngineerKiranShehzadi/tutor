'use client';
import { useEffect, useRef, useState } from 'react';
import { isCanceled } from './monitor-api';

interface State<T> { data: T | null; loading: boolean; error: boolean }

// Loads one dashboard section on its own. `resetKey` (the window) clears the
// data and shows the skeleton; `tick` (auto-refresh) refetches silently and
// keeps showing the previous data if the refetch fails.
export function useMonitorData<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  resetKey: string,
  tick: number,
) {
  const [state, setState] = useState<State<T>>({ data: null, loading: true, error: false });
  const [retry, setRetry] = useState(0);
  const lastKey = useRef(resetKey);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    const controller = new AbortController();
    if (lastKey.current !== resetKey) {
      lastKey.current = resetKey;
      setState({ data: null, loading: true, error: false });
    }
    fetcherRef.current(controller.signal)
      .then((data) => setState({ data, loading: false, error: false }))
      .catch((e) => {
        if (isCanceled(e) || controller.signal.aborted) return;
        setState((s) => ({ ...s, loading: false, error: true }));
      });
    return () => controller.abort();
  }, [resetKey, tick, retry]);

  const reload = () => { setState((s) => (s.data ? s : { ...s, loading: true, error: false })); setRetry((n) => n + 1); };
  return { ...state, reload };
}
