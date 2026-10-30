import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';

const api = axios.create({
  baseURL:         process.env.NEXT_PUBLIC_API_URL,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

// Attach access token from localStorage on every request
api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('accessToken');
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Auto-refresh access token on 401
let refreshPromise: Promise<string | null> | null = null;

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

    // These endpoints return 401 as a legitimate business error (wrong password,
    // Google-only account, bad OTP, etc.) — never treat them as expired sessions.
    const AUTH_ENDPOINTS = ['/auth/login', '/auth/register', '/auth/refresh-token',
                            '/auth/verify-email', '/auth/forgot-password', '/auth/reset-password'];
    if (AUTH_ENDPOINTS.some(p => original.url?.includes(p))) {
      if (original.url?.includes('/auth/refresh-token')) {
        localStorage.removeItem('accessToken');
        if (typeof window !== 'undefined') window.location.href = '/login';
      }
      return Promise.reject(error);
    }

    if (error.response?.status === 401 && !original._retry) {
      original._retry = true;
      try {
        // Deduplicate: reuse an in-flight refresh rather than firing N parallel ones
        if (!refreshPromise) {
          refreshPromise = api.post('/auth/refresh-token')
            .then(({ data }) => data.data.accessToken as string)
            .catch(() => null)
            .finally(() => { refreshPromise = null; });
        }
        const newToken = await refreshPromise;
        if (!newToken) {
          localStorage.removeItem('accessToken');
          if (typeof window !== 'undefined') window.location.href = '/login';
          return Promise.reject(error);
        }
        localStorage.setItem('accessToken', newToken);
        original.headers.Authorization = `Bearer ${newToken}`;
        return api(original);
      } catch {
        localStorage.removeItem('accessToken');
        if (typeof window !== 'undefined') window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default api;

// ── Typed helpers ─────────────────────────────────────
export const authApi = {
  register:         (data: { name: string; email: string; password: string }) =>
                      api.post('/auth/register', data),
  login:            (data: { email: string; password: string }) =>
                      api.post('/auth/login', data),
  resendLoginOtp:   (email: string) => api.post('/auth/resend-login-otp', { email }),
  logout:           () => api.post('/auth/logout'),
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
  rowsInFile: number;
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
  exportXlsx: (lectureId: number) => api.get(`/datasets/export/${lectureId}`, { responseType: 'blob' }),
};

// Observability API calls live in ./observability-api.ts (kept separate —
// see that file — so this one doesn't grow into an unmaintainable catch-all).
