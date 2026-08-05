import api from './api';
import type {
  TraceDetail, TraceListResult, SpanListResult, ObservabilitySpan, Annotation, Note,
  SessionSummary, SessionDetail, OverviewMetrics, PhoenixCapabilities, ObservabilityStatus,
  ObservabilityErrorCode,
} from '@/types/observability';

// Thin typed wrappers over the shared axios instance (see ./api.ts) —
// unwraps the backend's { success, data } / { success:false, code, message }
// envelope and normalizes failures into ObservabilityApiError so callers
// get a stable `.code` to branch on (PHOENIX_DISABLED vs UNREACHABLE vs
// TRACE_NOT_FOUND, etc.) instead of parsing raw axios errors everywhere.

export class ObservabilityApiError extends Error {
  code: ObservabilityErrorCode | 'UNKNOWN';
  constructor(code: ObservabilityErrorCode | 'UNKNOWN', message: string) {
    super(message);
    this.name = 'ObservabilityApiError';
    this.code = code;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrapError(err: any): never {
  const data = err?.response?.data;
  if (data && data.success === false) throw new ObservabilityApiError(data.code ?? 'UNKNOWN', data.message ?? 'Request failed');
  if (err?.code === 'ERR_CANCELED') throw err; // let callers distinguish cancellation from a real failure
  throw new ObservabilityApiError('UNKNOWN', err?.message ?? 'Request failed');
}

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

export interface OverviewFilters {
  startTime?: string;
  endTime?: string;
  lectureId?: string;
  sessionId?: string;
  route?: string;
  status?: string;
  environment?: string;
}

export const observabilityApi = {
  getStatus: async (signal?: AbortSignal): Promise<ObservabilityStatus> => {
    try { return (await api.get('/observability/status', { signal })).data.data; } catch (e) { return unwrapError(e); }
  },

  getCapabilities: async (signal?: AbortSignal): Promise<PhoenixCapabilities> => {
    try { return (await api.get('/observability/capabilities', { signal })).data.data; } catch (e) { return unwrapError(e); }
  },

  getOverview: async (filters: OverviewFilters, signal?: AbortSignal): Promise<{ metrics: OverviewMetrics; meta: { coveredTraceCount: number; truncated: boolean } }> => {
    try {
      const res = await api.get(`/observability/overview${qs(filters as Record<string, string | undefined>)}`, { signal });
      return { metrics: res.data.data, meta: res.data.meta };
    } catch (e) { return unwrapError(e); }
  },

  listTraces: async (params: Record<string, string | number | boolean | undefined | null>, signal?: AbortSignal): Promise<TraceListResult> => {
    try { return (await api.get(`/observability/traces${qs(params)}`, { signal })).data.data; } catch (e) { return unwrapError(e); }
  },

  getTrace: async (traceId: string, signal?: AbortSignal): Promise<TraceDetail> => {
    try { return (await api.get(`/observability/traces/${encodeURIComponent(traceId)}`, { signal })).data.data; } catch (e) { return unwrapError(e); }
  },

  addTraceNote: async (traceId: string, note: string): Promise<{ id: string } | null> => {
    try { return (await api.post(`/observability/traces/${encodeURIComponent(traceId)}/notes`, { note })).data.data; } catch (e) { return unwrapError(e); }
  },

  addTraceAnnotation: async (traceId: string, name: string, label?: string, score?: number): Promise<Annotation | null> => {
    try { return (await api.post(`/observability/traces/${encodeURIComponent(traceId)}/annotations`, { name, label, score })).data.data; } catch (e) { return unwrapError(e); }
  },

  listSpans: async (params: Record<string, string | number | boolean | undefined | null>, signal?: AbortSignal): Promise<SpanListResult> => {
    try { return (await api.get(`/observability/spans${qs(params)}`, { signal })).data.data; } catch (e) { return unwrapError(e); }
  },

  getSpan: async (spanId: string, signal?: AbortSignal): Promise<{ span: ObservabilitySpan; annotations: Annotation[]; notes: Note[] }> => {
    try { return (await api.get(`/observability/spans/${encodeURIComponent(spanId)}`, { signal })).data.data; } catch (e) { return unwrapError(e); }
  },

  addSpanNote: async (spanId: string, note: string): Promise<{ id: string }> => {
    try { return (await api.post(`/observability/spans/${encodeURIComponent(spanId)}/notes`, { note })).data.data; } catch (e) { return unwrapError(e); }
  },

  listSessions: async (params: { cursor?: string | null; limit?: number }, signal?: AbortSignal): Promise<{ sessions: SessionSummary[]; nextCursor: string | null }> => {
    try { return (await api.get(`/observability/sessions${qs(params)}`, { signal })).data.data; } catch (e) { return unwrapError(e); }
  },

  getSession: async (sessionId: string, signal?: AbortSignal): Promise<SessionDetail> => {
    try { return (await api.get(`/observability/sessions/${encodeURIComponent(sessionId)}`, { signal })).data.data; } catch (e) { return unwrapError(e); }
  },

  addSessionNote: async (sessionId: string, note: string): Promise<{ id: string }> => {
    try { return (await api.post(`/observability/sessions/${encodeURIComponent(sessionId)}/notes`, { note })).data.data; } catch (e) { return unwrapError(e); }
  },
};
