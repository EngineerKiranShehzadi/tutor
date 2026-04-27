import { Request } from 'express';

export interface User {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  avatar_url: string | null;
  is_verified: boolean;
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
  user?: Pick<User, 'id' | 'name' | 'email'>;
}

export interface JwtPayload {
  userId: string;
  iat?: number;
  exp?: number;
}

export interface ApiResponse<T = undefined> {
  success: boolean;
  message: string;
  data?: T;
  errors?: Record<string, string>[];
}
