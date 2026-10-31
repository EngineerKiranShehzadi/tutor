import { createApp } from './app';
import pool, { connectDB } from './config/database';
import { verifyEmailTransport } from './services/email.service';
import { purgeExpiredRefreshTokens } from './services/auth.service';
import { env } from './config/env';
import { assertRetrievalProvidersConfigured } from './config/retrieval-providers';
import { logger } from './utils/logger';
import { shutdownPhoenixExporter } from './observability/phoenix';
import { startMaintenanceScheduler, stopMaintenanceScheduler } from './observability/maintenance.scheduler';
import type { Server } from 'http';

// Graceful shutdown on SIGTERM/SIGINT: stop taking new connections, let
// in-flight requests finish (their traces are exported when they end), flush
// the pending traces to Phoenix, close the DB pool, then exit 0. A hard
// deadline (SHUTDOWN_TIMEOUT_MS) forces exit 1 if any step hangs. The dataset
// resume interval below is unref()'d, so it never holds shutdown up.
let shuttingDown = false;

const installShutdownHandlers = (server: Server): void => {
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopMaintenanceScheduler();
    logger.info(`[SHUTDOWN] ${signal} received — shutting down gracefully (limit ${env.SHUTDOWN_TIMEOUT_MS}ms)`);

    const startedAt = Date.now();
    setTimeout(() => {
      logger.error(`[SHUTDOWN] Not finished within ${env.SHUTDOWN_TIMEOUT_MS}ms — forcing exit`);
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS).unref();

    try {
      // Wait for in-flight requests, but for at most half the budget so a
      // stuck connection (e.g. an open stream) cannot eat the time needed to
      // flush traces.
      await new Promise<void>(resolve => {
        const grace = setTimeout(resolve, Math.floor(env.SHUTDOWN_TIMEOUT_MS / 2));
        grace.unref();
        server.close(() => { clearTimeout(grace); resolve(); });
        server.closeIdleConnections();
      });

      const remainingMs = env.SHUTDOWN_TIMEOUT_MS - (Date.now() - startedAt);
      await shutdownPhoenixExporter(Math.max(500, remainingMs - 1000));

      await pool.end();
      logger.info('[SHUTDOWN] Clean exit');
      process.exit(0);
    } catch (err) {
      logger.error('[SHUTDOWN] Error during shutdown', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });
};

const start = async () => {
  try {
    assertRetrievalProvidersConfigured();
    await connectDB();

    // Only verify email transport if credentials are configured
    if (env.NODE_ENV !== 'test' && env.EMAIL.USER && env.EMAIL.PASSWORD) {
      try {
        await verifyEmailTransport();
      } catch (emailErr) {
        logger.warn('Email transport verification failed — emails will not be sent until credentials are fixed', emailErr);
      }
    }

    const app = await createApp();

    const server = app.listen(env.PORT, () => {
      logger.info(`AskAITutor backend running on port ${env.PORT} [${env.NODE_ENV}]`);
      logger.info(`GraphQL endpoint: http://localhost:${env.PORT}/graphql`);

      // Request-log retention always runs; the email alert check inside it
      // only when OBSERVABILITY_ALERTS_ENABLED.
      if (env.NODE_ENV !== 'test') {
        startMaintenanceScheduler();
      }

      // Expired refresh tokens are never read again; drop them a minute after
      // start and then every 6 hours, so the table cannot grow without bound.
      const purgeRefreshTokens = (): void => {
        void purgeExpiredRefreshTokens().catch(err => logger.error('[AUTH] refresh-token purge failed', err));
      };
      setTimeout(purgeRefreshTokens, 60_000).unref();
      setInterval(purgeRefreshTokens, 6 * 60 * 60 * 1000).unref();

      // Continue any dataset build that was interrupted by a restart. Only
      // chunks that still have no embedding are processed; finished work is
      // never repeated. Runs in the background — startup does not wait for it.
      import('./services/dataset-version.service')
        .then(m => {
          void m.resumePendingVersions().catch(err => logger.error('[DATASET] resume on startup failed', err));
          // Safety net: if a retry timer was ever lost, a build still finishes on its own.
          setInterval(() => {
            void m.resumePendingVersions().catch(err => logger.error('[DATASET] periodic resume failed', err));
          }, 60_000).unref();
        })
        .catch(err => logger.error('[DATASET] resume on startup failed', err));
    });

    installShutdownHandlers(server);
  } catch (err) {
    logger.error('Failed to start server', err);
    process.exit(1);
  }
};

start();
