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
import { logger } from './utils/logger';

export const createApp = async (): Promise<Express> => {
  logger.info('[APP] Initialising Express application...');
  const app = express();

  // ── Security ──────────────────────────────────────────
  app.use(helmet());
  logger.info(`[APP] CORS allowed origin: ${env.FRONTEND_URL}`);
  app.use(cors({
    origin:      env.FRONTEND_URL,
    credentials: true,
    methods:     ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  }));

  // ── Parsing & Logging ─────────────────────────────────
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));
  app.use(cookieParser());
  app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));
  logger.info(`[APP] Morgan HTTP logger active (format=${env.NODE_ENV === 'production' ? 'combined' : 'dev'})`);

  // ── REST Routes (global limiter applies only here) ────
  // /graphql has its own per-mutation rate limiting in the resolvers
  app.use('/api/v1', globalLimiter, routes);
  logger.info('[APP] REST routes mounted at /api/v1');

  // ── GraphQL (/graphql) ────────────────────────────────
  await setupApollo(app);

  // ── 404 ───────────────────────────────────────────────
  app.use((req, res) => {
    logger.warn(`[APP] 404 Not Found — ${req.method} ${req.originalUrl}`);
    res.status(404).json({ success: false, message: 'Route not found' });
  });

  // ── Global Error Handler ──────────────────────────────
  app.use(errorHandler);

  logger.info('[APP] ✅ Express application ready');
  return app;
};
