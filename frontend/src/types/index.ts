// ── Auth ──────────────────────────────────────────────
export type UserRole = 'STUDENT' | 'ADMIN';

export interface User {
  id:          string;
  name:        string;
  email:       string;
  role:        UserRole;
  avatar_url?: string | null;
  created_at?: string;
  google_id?:  string | null;
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

// ── DB Lecture (from GraphQL) ─────────────────────────
export interface DBLecture {
  id:              string;
  title:           string;
  description?:    string;
  youtubeUrl:      string;
  youtubeVideoId?: string;
  status:          'NO_DATASET' | 'DATASET_UPLOADED' | 'PROCESSING' | 'EMBEDDING' | 'READY' | 'FAILED';
  progressCurrent: number;
  progressTotal:   number;
  createdAt:       string;
  updatedAt:       string;
}

// ── Legacy local Lecture (hardcoded constants) ────────
export interface Lecture {
  id:        string;
  num:       number;
  title:     string;
  duration:  string;
  videoId:   string;
  watched:   number;
  agentName: string;
}

// ── Chat ──────────────────────────────────────────────
export type MessageRole = 'user' | 'ai';
export type MessageType = 'text' | 'voice';

export interface ChunkSource {
  id:        number;
  topic?:    string;
  question:  string;
  startTime?: string;
  endTime?:   string;
}

export interface ChatMessage {
  id:          string;
  role:        MessageRole;
  type:        MessageType;
  content:     string;
  citation?:   string;
  timestamp:   Date;
  sources?:    ChunkSource[];
  isStreaming?: boolean; // true while the typewriter animation is in progress
}
