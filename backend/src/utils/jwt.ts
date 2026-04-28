import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { JwtPayload, UserRole } from '../types';

export const generateAccessToken = (userId: string, role: UserRole): string =>
  jwt.sign({ userId, role }, env.JWT.SECRET, { expiresIn: env.JWT.EXPIRES_IN } as jwt.SignOptions);

export const generateRefreshToken = (userId: string, role: UserRole): string =>
  jwt.sign({ userId, role }, env.JWT.REFRESH_SECRET, { expiresIn: env.JWT.REFRESH_EXPIRES_IN } as jwt.SignOptions);

export const verifyAccessToken = (token: string): JwtPayload =>
  jwt.verify(token, env.JWT.SECRET) as JwtPayload;

export const verifyRefreshToken = (token: string): JwtPayload =>
  jwt.verify(token, env.JWT.REFRESH_SECRET) as JwtPayload;
