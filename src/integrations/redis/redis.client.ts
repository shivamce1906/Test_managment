import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';
import { logger } from '../../utils';
import { env } from '../../config';

let redisClient: Redis;

export function getRedisClient(): Redis {
  if (!redisClient) {
    const redisUrl = env.REDIS_URL;
    if (env.NODE_ENV === 'production' && !redisUrl) {
      throw new Error(
        'REDIS_URL is required in production to maintain distributed sessions, token revocation, and queue state.'
      );
    }

    if (env.NODE_ENV === 'test' || !redisUrl) {
      logger.info('Using in-memory RedisMock client');
      redisClient = new RedisMock() as unknown as Redis;
    } else {
      try {
        redisClient = new Redis(redisUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          retryStrategy(times) {
            if (env.NODE_ENV === 'production' && times > 5) {
              return null;
            }
            return Math.min(times * 100, 3000);
          },
        });
        redisClient.on('error', (err) => {
          logger.error({ err }, 'Redis connection error');
        });
      } catch (err) {
        if (env.NODE_ENV === 'production') {
          logger.fatal({ err }, 'Failed to initialize Redis client in production. In-memory mock fallback is disabled.');
          throw err;
        }
        logger.warn({ err }, 'Could not create Redis connection, falling back to mock for development/test');
        redisClient = new RedisMock() as unknown as Redis;
      }
    }
  }
  return redisClient;
}

export function useMockRedis(): Redis {
  if (env.NODE_ENV === 'production') {
    throw new Error('useMockRedis() cannot be invoked in production.');
  }
  if (redisClient && typeof (redisClient as any).disconnect === 'function') {
    try {
      (redisClient as any).disconnect(false);
    } catch {}
  }
  logger.info('Using in-memory RedisMock client');
  redisClient = new RedisMock() as unknown as Redis;
  return redisClient;
}

export function getBullConnection(): Redis {
  const redisUrl = env.REDIS_URL;
  if (env.NODE_ENV === 'production' && !redisUrl) {
    throw new Error('REDIS_URL is required in production for BullMQ background queues.');
  }
  if (env.NODE_ENV === 'test' || !redisUrl) {
    return new RedisMock({ maxRetriesPerRequest: null }) as unknown as Redis;
  }
  return new Redis(redisUrl, {
    maxRetriesPerRequest: null,
  });
}

export async function disconnectRedis(): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.quit();
    } catch {
      // ignore
    }
  }
}
