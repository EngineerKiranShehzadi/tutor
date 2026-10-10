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
  // Pointer to the raw uploaded dataset file archived in S3 (see
  // services/s3-storage.service.ts) — null until a dataset has been
  // uploaded at least once.
  dataset_s3_bucket: string | null;
  dataset_s3_key: string | null;
  dataset_original_filename: string | null;
  created_at: Date;
  updated_at: Date;
}

// ── Lecture Agent Profile ─────────────────────────────────────
// One row per lecture (lecture_id is the primary key) — see migration
// src/db/migrations/005_lecture_agent_profiles.sql. Mirrors that table
// column for column; read through services/lecture-agent-profile.service.ts.
export interface LectureAgentProfile {
  lecture_id: number;
  agent_name: string;
  instructions: string;
  is_active: boolean;
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
  // Position of this chunk among the pieces a long answer was split into
  // (0 for a row that fit as a single chunk). Optional because several
  // read paths — analytics, answer-memory citations — don't select it and
  // don't need it; retrieval/dedupe paths always populate it.
  chunk_index?: number;
  similarity?: number;
  rerankScore?: number;
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
