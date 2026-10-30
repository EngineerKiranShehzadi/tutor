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

export const monitorApi = {
  getSummary: async (window: MonitorWindow, signal?: AbortSignal): Promise<MonitorSummary> =>
    (await api.get('/observability/monitor/summary', { params: { window }, signal })).data.data,

  // /health/ready answers 503 with a full JSON body when something required
  // is down — that is the data we want, not an error, so accept it.
  getReadiness: async (signal?: AbortSignal): Promise<ReadinessResult> =>
    (await api.get('/health/ready', { signal, validateStatus: (s) => s === 200 || s === 503 })).data,
};

export const isCanceled = (err: unknown): boolean =>
  (err as { code?: string })?.code === 'ERR_CANCELED';
