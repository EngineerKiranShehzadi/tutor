import api from '@/lib/api';

// Same shared axios instance and { success, data } envelope handling as
// lib/observability-api.ts. Kept in components/monitor/ for now.

export type MonitorWindow = '24h' | '7d' | '30d';
export const MONITOR_WINDOWS: MonitorWindow[] = ['24h', '7d', '30d'];

export interface PeriodSummary {
  totalRequests: number;
  answeredRate: number | null;
  notFoundRate: number | null;
  guardrailRejectedRate: number | null;
  errorRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  totalCostUsd: number | null;
  tokens: { input: number; output: number; total: number };
  memorySkippedForPii: number;
}

export interface MonitorSummary {
  window: MonitorWindow;
  current: PeriodSummary;
  previous: PeriodSummary;
}

export type ComponentStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface ReadinessResult {
  status: ComponentStatus;
  checkedAt: string;
  components: Record<string, { status: ComponentStatus; latencyMs: number; errorCode?: string }>;
}

export interface TimeseriesBucket { bucket: string; answered: number; notFound: number; errors: number; p95Ms: number }
export interface MonitorTimeseries { window: MonitorWindow; bucketSize: 'hour' | 'day'; buckets: TimeseriesBucket[] }

export type AttentionReason = 'error' | 'not_answered' | 'verifier' | 'slow';
export interface AttentionRow {
  traceId: string;
  createdAt: string;
  lectureId: number | null;
  lectureTitle: string | null;
  route: string | null;
  responseStatus: string | null;
  notFoundReason: string | null;
  errorCode: string | null;
  answerVerificationReason: string | null;
  totalMs: number;
  exportedToPhoenix: boolean;
  reasons: AttentionReason[];
  phoenixTraceUrl: string | null;
}
export interface AttentionPage { rows: AttentionRow[]; nextBefore: string | null }

export interface LectureStats {
  lectureId: number;
  title: string;
  requests: number;
  answeredRate: number | null;
  notFoundRate: number | null;
  p50Ms: number | null;
}

export interface StageStats { stage: string; p50Ms: number; p95Ms: number; count: number }

export const monitorApi = {
  getSummary: async (window: MonitorWindow, signal?: AbortSignal): Promise<MonitorSummary> =>
    (await api.get('/observability/monitor/summary', { params: { window }, signal })).data.data,

  getTimeseries: async (window: MonitorWindow, signal?: AbortSignal): Promise<MonitorTimeseries> =>
    (await api.get('/observability/monitor/timeseries', { params: { window }, signal })).data.data,

  // Not windowed on the backend: newest problems first, paged by `before`.
  getAttention: async (before: string | null, signal?: AbortSignal): Promise<AttentionPage> => {
    const res = (await api.get('/observability/monitor/attention', { params: { limit: 25, ...(before ? { before } : {}) }, signal })).data;
    return { rows: res.data, nextBefore: res.meta?.nextBefore ?? null };
  },

  getLectures: async (window: MonitorWindow, signal?: AbortSignal): Promise<LectureStats[]> =>
    (await api.get('/observability/monitor/lectures', { params: { window }, signal })).data.data.lectures,

  getStages: async (window: MonitorWindow, signal?: AbortSignal): Promise<StageStats[]> =>
    (await api.get('/observability/monitor/stages', { params: { window }, signal })).data.data.stages,

  // /health/ready answers 503 with a full JSON body when something required
  // is down — that is the data we want, not an error, so accept it.
  getReadiness: async (signal?: AbortSignal): Promise<ReadinessResult> =>
    (await api.get('/health/ready', { signal, validateStatus: (s) => s === 200 || s === 503 })).data,
};

export const isCanceled = (err: unknown): boolean =>
  (err as { code?: string })?.code === 'ERR_CANCELED';
