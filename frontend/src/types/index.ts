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

// ── API ───────────────────────────────────────────────
export interface ApiResponse<T = undefined> {
  success: boolean;
  message: string;
  data?:   T;
  errors?: { field: string; message: string }[];
}

// ── Course / Lecture ──────────────────────────────────
export interface Lecture {
  id:       string;
  num:      number;
  title:    string;
  duration: string;
  videoId:  string;
  watched:  number; // 0–100 percent
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
