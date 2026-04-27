import { createApp } from './app';
import { connectDB } from './config/database';
import { verifyEmailTransport } from './services/email.service';
import { env } from './config/env';
import { logger } from './utils/logger';

const start = async () => {
  try {
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

    app.listen(env.PORT, () => {
      logger.info(`AskAITutor backend running on port ${env.PORT} [${env.NODE_ENV}]`);
      logger.info(`GraphQL endpoint: http://localhost:${env.PORT}/graphql`);
    });
  } catch (err) {
    logger.error('Failed to start server', err);
    process.exit(1);
  }
};

start();
