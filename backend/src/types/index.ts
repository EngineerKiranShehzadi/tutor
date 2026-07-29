import { Request } from 'express';

export type UserRole = 'STUDENT' | 'ADMIN';

export interface User {
  id: string;           // UUID
  name: string;
  email: string;
  password_hash: string | null;
  google_id: string | null;
  avatar_url: string | null;
  is_verified: boolean;
  role: UserRole;
  created_at: Date;
  updated_at: Date;
}

export interface PasswordResetToken {
  id: string;
  user_id: string;
  code_hash: string;
  expires_at: Date;
  used: boolean;
  verified: boolean;
  created_at: Date;
}

export interface EmailVerificationToken {
  id: string;
  user_id: string;
  code_hash: string;
  expires_at: Date;
  used: boolean;
  created_at: Date;
}

export interface AuthenticatedRequest extends Request {
  user?: Pick<User, 'id' | 'name' | 'email' | 'role'>;
}

export interface JwtPayload {
  userId: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}

export interface ApiResponse<T = undefined> {
  success: boolean;
  message: string;
  data?: T;
  errors?: Record<string, string>[];
}

// ── Lecture ────────────────────────────────────────────────────
export type LectureStatus =
  | 'NO_DATASET'
  | 'DATASET_UPLOADED'
  | 'PROCESSING'
  | 'EMBEDDING'
  | 'READY'
  | 'FAILED';

export interface Lecture {
  id: number;
  title: string;
  description: string | null;
  youtube_url: string;
  youtube_video_id: string | null;
  status: LectureStatus;
  progress_current: number;
  progress_total: number;
  created_at: Date;
  updated_at: Date;
}

// ── QnA Chunk ─────────────────────────────────────────────────
export interface QnaChunk {
  id: number;
  lecture_id: number;
  topic: string | null;
  question: string;
  answer: string;
  chunk_text: string;
  start_time: string | null;
  end_time: string | null;
  keywords: string | null;
  similarity?: number;
}

// ── Chat History ───────────────────────────────────────────────
export interface ChatHistoryEntry {
  id: number;
  student_id: string;
  lecture_id: number;
  question: string;
  answer: string;
  source_chunk_ids: number[] | null;
  cleared_by_student: boolean;
  created_at: Date;
}
