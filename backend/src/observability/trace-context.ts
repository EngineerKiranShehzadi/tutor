import { AsyncLocalStorage } from 'async_hooks';
import type { RequestTrace } from './tracer';

export interface ActiveSpanContext {
  trace: RequestTrace;
  parentSpanId: string;
}

// Lives in its own module (type-only import of tracer) so utils/logger.ts can
// read the active trace ID without a runtime circular import: tracer.ts
// imports logger, and logger needs this storage.
export const spanContextStorage = new AsyncLocalStorage<ActiveSpanContext>();

export function getActiveTraceId(): string | undefined {
  return spanContextStorage.getStore()?.trace.traceId;
}
