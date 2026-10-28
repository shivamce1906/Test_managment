import './config/env';
import { createApp } from './app';
import { connectDb, disconnectDb, env } from './config';
import { getRedisClient, useMockRedis } from './integrations';
import { logger } from './utils';

const PORT = env.PORT;
const MONGO_URI = env.MONGODB_URI;

async function bootstrap() {
  try {
    logger.info('Connecting to database...');
    console.log("connection string", MONGO_URI)
    await connectDb(MONGO_URI);
    logger.info('Database connected successfully');

    let redis = getRedisClient();
    try {
      await redis.ping();
      logger.info('Redis connected successfully');
    } catch {
      logger.warn('Local Redis is offline, using in-memory mock client');
      redis = useMockRedis();
    }

    const app = createApp();
    const server = app.listen(PORT, async () => {
      logger.info({ port: PORT }, `Glox Salon API server running on port ${PORT}`);

      // Auto-start background workers (Point 4: Process PDF, WhatsApp & Day-End queues automatically)
      if (process.env.RUN_STANDALONE_WORKER !== 'true') {
        try {
          const { startBackgroundWorkers } = await import('./workers');
          await startBackgroundWorkers();
          logger.info('Background workers initialized: queues will process automatically');
        } catch (workerErr) {
          logger.warn({ err: workerErr }, 'Notice: Background workers not started in server process');
        }
      }
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      server.close(async () => {
        try {
          try {
            const { stopBackgroundWorkers } = await import('./workers');
            await stopBackgroundWorkers();
          } catch { }
          await disconnectDb();
          await redis.quit();
          logger.info('Closed database and redis connections. Process exiting.');
          process.exit(0);
        } catch (err) {
          logger.error({ err }, 'Error during graceful shutdown');
          process.exit(1);
        }
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.fatal({ err }, 'Failed to start Glox Salon API server');
    process.exit(1);
  }
}

bootstrap();
