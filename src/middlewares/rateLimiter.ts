import rateLimit, { Store, IncrementResponse, Options } from 'express-rate-limit';
import { AppError, ErrorCode } from '../utils';
import { getRedisClient } from '../integrations/redis/redis.client';

class RedisRateLimitStore implements Store {
  private windowMs = 60 * 1000;
  public prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const redis = getRedisClient();
    const fullKey = `${this.prefix}${key}`;
    const totalHits = await redis.incr(fullKey);
    if (totalHits === 1) {
      await redis.pexpire(fullKey, this.windowMs);
    }
    let ttlMs = await redis.pttl(fullKey);
    if (ttlMs < 0) {
      await redis.pexpire(fullKey, this.windowMs);
      ttlMs = this.windowMs;
    }
    return {
      totalHits,
      resetTime: new Date(Date.now() + ttlMs),
    };
  }

  async decrement(key: string): Promise<void> {
    const redis = getRedisClient();
    await redis.decr(`${this.prefix}${key}`);
  }

  async resetKey(key: string): Promise<void> {
    const redis = getRedisClient();
    await redis.del(`${this.prefix}${key}`);
  }
}

export const standardRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300, // 300 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:std:'),
  passOnStoreError: true,
  handler: (req, res, next) => {
    next(new AppError(429, ErrorCode.RATE_LIMITED, 'Too many requests, please try again later'));
  },
});

export const authRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 attempts per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:auth:'),
  passOnStoreError: true,
  handler: (req, res, next) => {
    next(new AppError(429, ErrorCode.RATE_LIMITED, 'Too many authentication attempts, please try again later'));
  },
});
