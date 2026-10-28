import './testEnv';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../../src/config/db';
import { getRedisClient, disconnectRedis } from '../../src/integrations';
import { resetRateLimits } from '../../src/middlewares/rateLimiter';

let replSet: MongoMemoryReplSet | null = null;

function assertLocal(uri: string) {
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+/.test(uri)) {
    throw new Error(`Refusing to run tests against non-local MongoDB: ${uri}`);
  }
}

/**
 * Starts an in-memory replica set and connects through the app's own connectDb()
 * (autoIndex: false), so tests see exactly the index behaviour production gets.
 */
export async function startDb(): Promise<string> {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const uri = replSet.getUri('glox_test');
  assertLocal(uri);
  await connectDb(uri);
  return uri;
}

export async function clearDb(): Promise<void> {
  const host = (mongoose.connection as any).host;
  if (host && !['127.0.0.1', 'localhost'].includes(host)) {
    throw new Error(`Refusing to clear non-local database host ${host}`);
  }
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
  await getRedisClient().flushall();
  resetRateLimits();
}

export async function stopDb(): Promise<void> {
  await disconnectDb();
  if (replSet) {
    await replSet.stop();
    replSet = null;
  }
  await disconnectRedis();
}

/** Builds every index declared on the Mongoose schemas (what production should run once). */
export async function syncAllIndexes(): Promise<void> {
  for (const name of mongoose.modelNames()) {
    await mongoose.model(name).syncIndexes();
  }
}

/** Standard lifecycle for an integration test file. */
export function useTestDb(opts: { clearBetween?: boolean } = { clearBetween: true }) {
  beforeAll(async () => {
    await startDb();
  });
  if (opts.clearBetween !== false) {
    beforeEach(async () => {
      await clearDb();
    });
  }
  afterAll(async () => {
    await stopDb();
  });
}
