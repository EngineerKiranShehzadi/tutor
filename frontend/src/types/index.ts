// ── Auth ──────────────────────────────────────────────
export interface User {
  id:         string;
  name:       string;
  email:      string;
  avatar_url: string | null;
  created_at: string;
}

export interface AuthState {
  user:        User | null;
  accessToken: string | null;
  isLoading:   boolean;
}

export type LoginResult =
  | { status: 'AUTHENTICATED'; user: User; accessToken: string; refreshToken: string }
  | { status: 'EMAIL_VERIFICATION_REQUIRED'; email: string; verificationExpiresInSeconds: number };

// ── API ───────────────────────────────────────────────
export interface ApiResponse<T = undefined> {
  success: boolean;
  message: string;
  data?:   T;
  errors?: { field: string; message: string }[];
}

// ── Course / Lecture ──────────────────────────────────
export interface Lecture {
  id:        string;
  num:       number;
  title:     string;
  duration:  string;
  videoId:   string;
  watched:   number; // 0–100 percent
  agentName: string; // name of the dedicated AI tutor agent for this lecture
}

// ── Chat ──────────────────────────────────────────────
export type MessageRole = 'user' | 'ai';
export type MessageType = 'text' | 'voice';

export interface ChatMessage {
  id:        string;
  role:      MessageRole;
  type:      MessageType;
  content:   string;
  citation?: string;
  timestamp: Date;
}
