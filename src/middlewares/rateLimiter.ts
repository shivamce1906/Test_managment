import rateLimit, { Store, IncrementResponse, Options } from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config';
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

const intFromEnv = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/**
 * Who a request belongs to, for the per-user limit: the user id from a valid access token, or the
 * IP address for requests without one (login, webhooks). Only the signature is checked here (no
 * database read); authenticate() still does the full check afterwards.
 */
function userOrIpKey(req: Request): string {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(auth.slice(7), env.JWT_SECRET) as { sub?: string };
      if (decoded?.sub) return `u:${decoded.sub}`;
    } catch {
      // invalid or expired token: counted by IP; authenticate() will refuse it anyway
    }
  }
  return `ip:${req.ip}`;
}

const tooMany = (req: Request, res: Response, next: NextFunction) =>
  next(new AppError(429, ErrorCode.RATE_LIMITED, 'Too many requests, please try again later'));

/**
 * Per user: each logged-in person gets their own budget (default 300 requests per minute), so a
 * salon whose screens share one internet connection is not limited as a whole.
 */
const perUserRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: intFromEnv('API_RATE_LIMIT_PER_USER', 300),
  keyGenerator: userOrIpKey,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:user:'),
  passOnStoreError: true,
  handler: tooMany,
});

/** Per IP backstop (default 1,000 requests per minute) against floods from one address. */
const perIpRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: intFromEnv('API_RATE_LIMIT_PER_IP', 1000),
  standardHeaders: false,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:ip:'),
  passOnStoreError: true,
  handler: tooMany,
});

/** Both limits, applied to every request (app.use accepts the list). */
export const standardRateLimiter = [perIpRateLimiter, perUserRateLimiter];

export const authRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 failed attempts per minute per IP
  // Only failed logins count: staff sharing one internet connection are not blocked when they
  // type the right password. The per-account lockout (5 wrong passwords -> 15 min) still applies.
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:auth:'),
  passOnStoreError: true,
  handler: (req, res, next) => {
    next(new AppError(429, ErrorCode.RATE_LIMITED, 'Too many authentication attempts, please try again later'));
  },
});
