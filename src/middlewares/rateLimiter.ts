import rateLimit from 'express-rate-limit';
import { AppError, ErrorCode } from '../utils';

export const standardRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300, // 300 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next) => {
    next(new AppError(429, ErrorCode.RATE_LIMITED, 'Too many requests, please try again later'));
  },
});

export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // 30 requests per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next) => {
    next(new AppError(429, ErrorCode.RATE_LIMITED, 'Too many authentication attempts, please try again later'));
  },
});
