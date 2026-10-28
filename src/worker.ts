import './config/env';
import { connectDb, disconnectDb } from './config';
import { disconnectRedis } from './integrations';
import { logger } from './utils';
import { startBackgroundWorkers, stopBackgroundWorkers } from './workers';
import { env } from './config';

async function bootstrap() {
  await connectDb(env.MONGODB_URI);
  await startBackgroundWorkers();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Gracefully shutting down standalone worker process...');
    await stopBackgroundWorkers();
    await disconnectRedis();
    await disconnectDb();
    logger.info('Background worker process exit');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'Fatal error during worker bootstrap');
  process.exit(1);
});

