import express, { Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { globalLimiter } from './middleware/rateLimiter';
import { errorHandler } from './middleware/errorHandler';
import { env } from './config/env';
import routes from './routes';
import { setupApollo } from './graphql';

export const createApp = async (): Promise<Express> => {
  const app = express();

  // ── Security ──────────────────────────────────────────
  app.use(helmet());
  app.use(cors({
    origin:      env.FRONTEND_URL,
    credentials: true,
    methods:     ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  }));

  // ── Parsing & Logging ─────────────────────────────────
  app.use(express.json({ limit: '10kb' }));
  app.use(express.urlencoded({ extended: true, limit: '10kb' }));
  app.use(cookieParser());
  app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

  // ── REST Routes (global limiter applies only here) ────
  // /graphql has its own per-mutation rate limiting in the resolvers
  app.use('/api/v1', globalLimiter, routes);

  // ── GraphQL (/graphql) ────────────────────────────────
  await setupApollo(app);

  // ── 404 ───────────────────────────────────────────────
  app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found' }));

  // ── Global Error Handler ──────────────────────────────
  app.use(errorHandler);

  return app;
};
