// Cancellation-aware waits. Cancelling a DB read wait does not cancel its SQL.
export function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Operation cancelled');
}
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  checkAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, Math.max(0, ms));
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(signal?.reason ?? new Error('Operation cancelled')); };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
export function waitWithSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason ?? new Error('Operation cancelled'));
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
    // Both outcomes remain observed even if the caller has already cancelled.
    work.then(value => { signal.removeEventListener('abort', cancel); resolve(value); },
      error => { signal.removeEventListener('abort', cancel); reject(error); });
  });
}
