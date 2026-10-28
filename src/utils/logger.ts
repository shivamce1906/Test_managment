import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'password',
      'passwordHash',
      'accessToken',
      'refreshToken',
      'apiKey',
      'webhookSecret',
      '*.password',
      '*.passwordHash',
    ],
    remove: true,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
