import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const required = (key: string): string => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
};

const optional = (key: string, fallback: string): string =>
  process.env[key] ?? fallback;

export const env = {
  NODE_ENV:      optional('NODE_ENV', 'development'),
  PORT:          parseInt(optional('PORT', '5000'), 10),
  FRONTEND_URL:  optional('FRONTEND_URL', 'http://localhost:3000'),

  DB: {
    HOST:     optional('DB_HOST', 'localhost'),
    PORT:     parseInt(optional('DB_PORT', '5432'), 10),
    NAME:     optional('DB_NAME', 'askaitutor'),
    USER:     optional('DB_USER', 'postgres'),
    PASSWORD: required('DB_PASSWORD'),
    URL:      optional('DATABASE_URL', ''),
  },

  JWT: {
    SECRET:              required('JWT_SECRET'),
    EXPIRES_IN:          optional('JWT_EXPIRES_IN', '15m'),
    REFRESH_SECRET:      required('JWT_REFRESH_SECRET'),
    REFRESH_EXPIRES_IN:  optional('JWT_REFRESH_EXPIRES_IN', '7d'),
  },

  EMAIL: {
    HOST:       optional('EMAIL_HOST', 'smtp.gmail.com'),
    PORT:       parseInt(optional('EMAIL_PORT', '587'), 10),
    SECURE:     optional('EMAIL_SECURE', 'false') === 'true',
    USER:       optional('EMAIL_USER', ''),
    PASSWORD:   optional('EMAIL_PASSWORD', ''),
    FROM_NAME:  optional('EMAIL_FROM_NAME', 'AskAITutor'),
  },

  RATE_LIMIT: {
    WINDOW_MS:    parseInt(optional('RATE_LIMIT_WINDOW_MS', '900000'), 10),
    MAX:          parseInt(optional('RATE_LIMIT_MAX', '100'), 10),
    AUTH_MAX:     parseInt(optional('AUTH_RATE_LIMIT_MAX', '10'), 10),
  },

  BCRYPT_SALT_ROUNDS: parseInt(optional('BCRYPT_SALT_ROUNDS', '12'), 10),

  GEMINI_API_KEY: optional('GEMINI_API_KEY', ''),

  GOOGLE: {
    CLIENT_ID:     optional('GOOGLE_CLIENT_ID', ''),
    CLIENT_SECRET: optional('GOOGLE_CLIENT_SECRET', ''),
    CALLBACK_URL:  optional('GOOGLE_CALLBACK_URL', 'http://localhost:5000/api/v1/auth/google/callback'),
  },
} as const;
