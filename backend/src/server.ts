import app from './app';
import { connectDB } from './config/database';
import { verifyEmailTransport } from './services/email.service';
import { env } from './config/env';
import { logger } from './utils/logger';

const start = async () => {
  try {
    await connectDB();
    if (env.NODE_ENV !== 'test') await verifyEmailTransport();

    app.listen(env.PORT, () => {
      logger.info(`AskAITutor backend running on port ${env.PORT} [${env.NODE_ENV}]`);
    });
  } catch (err) {
    logger.error('Failed to start server', err);
    process.exit(1);
  }
};

start();
