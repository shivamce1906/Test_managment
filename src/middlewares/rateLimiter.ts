import rateLimit, { MemoryStore } from 'express-rate-limit';
import { AppError, ErrorCode } from '../utils';
import { User, PlatformAdmin } from '../models';

const authStore = new MemoryStore();
const standardStore = new MemoryStore();

const getClientIp = (req: any) =>
  (typeof req.headers?.['x-forwarded-for'] === 'string'
    ? req.headers['x-forwarded-for'].split(',')[0].trim()
    : req.ip || '127.0.0.1');

export const standardRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300, // 300 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  store: standardStore,
  handler: (req, res, next) => {
    next(new AppError(429, ErrorCode.RATE_LIMITED, 'Too many requests, please try again later'));
  },
});

export const authRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  store: authStore,
  keyGenerator: (req) => getClientIp(req),
  skip: async (req) => {
    try {
      if (req.body?.email && typeof req.body.email === 'string') {
        const email = req.body.email.trim().toLowerCase();
        const user = await User.findOne({ email }, null, { skipTenantScope: true }).select('lockedUntil');
        if (user && user.lockedUntil && user.lockedUntil > new Date()) {
          return true;
        }
        const admin = await PlatformAdmin.findOne({ email }).select('lockedUntil');
        if (admin && admin.lockedUntil && admin.lockedUntil > new Date()) {
          return true;
        }
      }
    } catch {
      // ignore
    }
    return false;
  },
  handler: (req, res, next) => {
    next(new AppError(429, ErrorCode.RATE_LIMITED, 'Too many authentication attempts, please try again later'));
  },
});

export async function resetAuthRateLimitForIp(ip: string) {
  await authStore.resetKey(ip);
}

export function resetRateLimits() {
  authStore.resetAll();
  standardStore.resetAll();
}
