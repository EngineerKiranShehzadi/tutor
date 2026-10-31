import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { JwtPayload, UserRole } from '../types';

// Pinned on both sign and verify: only HS256 is accepted (no algorithm
// confusion), and issuer/audience tie a token to this API and to its purpose,
// so an access token is never accepted where a refresh token is expected or
// vice versa — on top of the two using different secrets.
const ALGORITHM = 'HS256' as const;
const ISSUER = 'askaitutor-api';
const ACCESS_AUDIENCE = 'askaitutor-access';
const REFRESH_AUDIENCE = 'askaitutor-refresh';

export const generateAccessToken = (userId: string, role: UserRole): string =>
  jwt.sign({ userId, role }, env.JWT.SECRET, {
    algorithm: ALGORITHM, issuer: ISSUER, audience: ACCESS_AUDIENCE,
    expiresIn: env.JWT.EXPIRES_IN,
  } as jwt.SignOptions);

// jwtid makes every refresh token unique: without it two tokens minted for the
// same user in the same second are byte-identical, and so share a stored hash.
export const generateRefreshToken = (userId: string, role: UserRole): string =>
  jwt.sign({ userId, role }, env.JWT.REFRESH_SECRET, {
    algorithm: ALGORITHM, issuer: ISSUER, audience: REFRESH_AUDIENCE,
    expiresIn: env.JWT.REFRESH_EXPIRES_IN, jwtid: crypto.randomUUID(),
  } as jwt.SignOptions);

export const verifyAccessToken = (token: string): JwtPayload =>
  jwt.verify(token, env.JWT.SECRET, {
    algorithms: [ALGORITHM], issuer: ISSUER, audience: ACCESS_AUDIENCE,
  }) as JwtPayload;

export const verifyRefreshToken = (token: string): JwtPayload =>
  jwt.verify(token, env.JWT.REFRESH_SECRET, {
    algorithms: [ALGORITHM], issuer: ISSUER, audience: REFRESH_AUDIENCE,
  }) as JwtPayload;
