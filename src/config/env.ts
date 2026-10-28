import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Try standard locations to find .env file
const candidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '../../../.env'),
  path.resolve(__dirname, '../.env'),
];

let loaded = false;
for (const envPath of candidates) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, quiet: true });
    loaded = true;
    break;
  }
}

if (!loaded) {
  dotenv.config({ quiet: true });
}

export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT) || 4000,
  // Standalone MongoDB default URI (For Replica Set, use: mongodb://localhost:27017/glox_salon?replicaSet=rs0)
  MONGODB_URI: process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/glox_salon',
  // MONGO_URI: process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/glox_salon',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  JWT_SECRET: process.env.JWT_SECRET || 'super-secret-jwt-key-min-32-chars-long-glox-salon-2026',
  JWT_ACCESS_TTL: process.env.JWT_ACCESS_TTL || '15m',
  REFRESH_TTL_SUPERADMIN: process.env.REFRESH_TTL_SUPERADMIN || '12h',
  REFRESH_TTL_OWNER: process.env.REFRESH_TTL_OWNER || '30d',
  REFRESH_TTL_MANAGER: process.env.REFRESH_TTL_MANAGER || '30d',
  REFRESH_TTL_BRANCH: process.env.REFRESH_TTL_BRANCH || '7d',
  KMS_KEY_ID: process.env.KMS_KEY_ID || 'local-aes-256-gcm-master-key-32bytes-secret!',
  ENCRYPTION_SECRET: process.env.ENCRYPTION_SECRET || process.env.KMS_KEY_ID || '01234567890123456789012345678901',
  S3_BUCKET: process.env.S3_BUCKET || 'glox-salon-uploads',
  AWS_REGION: process.env.AWS_REGION || 'ap-south-1',
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || 'mock-access-key',
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || 'mock-secret-key',
  AISENSY_BASE_URL: process.env.AISENSY_BASE_URL || 'https://backend.aisensy.com',
  AISENSY_API_KEY: process.env.AISENSY_API_KEY || 'mock-aisensy-key',
  WEBHOOK_BASE_URL: process.env.WEBHOOK_BASE_URL || 'http://localhost:4000/api/v1/webhooks',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  SENTRY_DSN: process.env.SENTRY_DSN || '',
  APP_ORIGINS: (process.env.APP_ORIGINS || 'http://localhost:3000,http://localhost:5173,https://app.gloxsalon.com').split(','),
  RUN_EMBEDDED_WORKER: process.env.RUN_EMBEDDED_WORKER === 'true',
  UPLOAD_DIR: process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads'),
};

/**
 * Helper to get any environment variable with an optional fallback default.
 */
export function getEnv(key: string, defaultValue?: string): string {
  return process.env[key] ?? defaultValue ?? '';
}

export default env;

