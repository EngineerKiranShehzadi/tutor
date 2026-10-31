import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { getAccessToken, setAccessToken, refreshAccessToken } from './auth-token';

const api = axios.create({
  baseURL:         process.env.NEXT_PUBLIC_API_URL,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

// Attach the in-memory access token (lib/auth-token.ts) on every request
api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = getAccessToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Auto-refresh access token on 401

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

    // These endpoints return 401 as a legitimate business error (wrong password,
    // Google-only account, bad OTP, etc.) — never treat them as expired sessions.
    const AUTH_ENDPOINTS = ['/auth/login', '/auth/refresh-token',
                            '/auth/verify-email', '/auth/forgot-password', '/auth/reset-password'];
    if (AUTH_ENDPOINTS.some(p => original.url?.includes(p))) {
      return Promise.reject(error);
    }

    if (error.response?.status === 401 && !original._retry) {
      original._retry = true;
      // Shared with Apollo / the chat stream: one refresh at a time per tab
      const newToken = await refreshAccessToken();
      if (!newToken) {
        setAccessToken(null);
        if (typeof window !== 'undefined') window.location.href = '/login';
        return Promise.reject(error);
      }
      original.headers.Authorization = `Bearer ${newToken}`;
      return api(original);
    }
    return Promise.reject(error);
  }
);

export default api;

// ── Typed helpers ─────────────────────────────────────
export const authApi = {
  login:            (data: { email: string; password: string }) =>
                      api.post('/auth/login', data),
  resendLoginOtp:   (email: string) => api.post('/auth/resend-login-otp', { email }),
  logout:           () => api.post('/auth/logout'),
  logoutAll:        () => api.post('/auth/logout-all'),
  forgotPassword:   (email: string) => api.post('/auth/forgot-password', { email }),
  resetPassword:    (token: string, password: string) =>
                      api.post(`/auth/reset-password/${token}`, { password }),
  getMe:            () => api.get('/auth/me'),
  updateProfile:    (data: { name?: string; currentPassword?: string; newPassword?: string; avatarUrl?: string }) =>
                      api.patch('/auth/me', data),
};

// ── Dataset versions (see backend dataset-version.service.ts) ─────────
export type DatasetMode = 'MERGE' | 'REPLACE';

export interface DatasetPreview {
  mode: DatasetMode;
  rowsInFile: number;    // data rows in the sheet, before skipping
  rowsUsed?: number;     // rows that became Q&As
  skippedRows?: number;  // empty question/answer → ignored
  skippedSamples?: { sheetRow: number; reason: 'EMPTY_QUESTION' | 'EMPTY_ANSWER' }[];
  truncatedRows?: number; // answer longer than the piece cap → the rest is dropped
  truncatedSamples?: { sheetRow: number; question: string; pieces: number; kept: number }[];
  added: number;
  updated: number;
  unchanged: number;
  carriedOver: number;   // MERGE: existing Q&As missing from the file, kept as they are
  reembeddedForModel: number; // MERGE: kept Q&As re-embedded because the embedding model changed
  removed: number;       // REPLACE: existing Q&As missing from the file, dropped
  removedSamples: { qaId: string; question: string }[];
  chunksToEmbed: number;
  chunksCopied: number;
  chunksReused: number;
  fileHasQaIdColumn: boolean;
  possibleDuplicates: { sheetRow: number; newQuestion: string; existingQaId: string; existingQuestion: string }[];
  possibleDuplicateCount: number;  // MERGE: added rows that look like edits of kept Q&As
}

export interface DatasetVersionInfo {
  id: number;
  version_no: number;
  status: 'BUILDING' | 'READY_TO_ACTIVATE' | 'ACTIVE' | 'SUPERSEDED' | 'FAILED' | 'ARCHIVED';
  mode: DatasetMode;
  source_filename: string | null;
  stats: Partial<DatasetPreview>;
  attempts: number;
  last_error: string | null;
  created_at: string;
  activated_at: string | null;
  is_active: boolean;
  chunk_count: string;
  pending_count: string;
  to_embed: number;
}

export const datasetApi = {
  // dryRun=true plans the update and returns what WOULD change without writing anything.
  upload: (lectureId: number, file: File, opts: { mode?: DatasetMode; dryRun?: boolean; confirmRemovals?: number } = {}) => {
    const form = new FormData();
    form.append('file', file);
    form.append('mode', opts.mode ?? 'MERGE');
    if (opts.dryRun) form.append('dryRun', 'true');
    if (opts.confirmRemovals !== undefined) form.append('confirmRemovals', String(opts.confirmRemovals));
    return api.post(`/datasets/upload/${lectureId}`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  versions: (lectureId: number) => api.get(`/datasets/versions/${lectureId}`),
  rollback: (lectureId: number) => api.post(`/datasets/rollback/${lectureId}`),
  // Stops the in-flight update (marks it failed); the live dataset is untouched.
  cancel: (lectureId: number) => api.post(`/datasets/cancel/${lectureId}`),
  exportXlsx: (lectureId: number) => api.get(`/datasets/export/${lectureId}`, { responseType: 'blob' }),
};

// Observability API calls live in ./observability-api.ts (kept separate —
// see that file — so this one doesn't grow into an unmaintainable catch-all).
