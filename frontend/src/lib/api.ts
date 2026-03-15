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
api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
    if (error.response?.status === 401 && !original._retry) {
      original._retry = true;
      try {
        const { data } = await api.post('/auth/refresh-token');
        localStorage.setItem('accessToken', data.data.accessToken);
        original.headers.Authorization = `Bearer ${data.data.accessToken}`;
        return api(original);
      } catch {
        localStorage.removeItem('accessToken');
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default api;

// ── Typed helpers ─────────────────────────────────────
export const authApi = {
  register:       (data: { name: string; email: string; password: string }) =>
                    api.post('/auth/register', data),
  login:          (data: { email: string; password: string }) =>
                    api.post('/auth/login', data),
  logout:         ()                   => api.post('/auth/logout'),
  forgotPassword: (email: string)      => api.post('/auth/forgot-password', { email }),
  resetPassword:  (token: string, password: string) =>
                    api.post(`/auth/reset-password/${token}`, { password }),
  getMe:          ()                   => api.get('/auth/me'),
};
