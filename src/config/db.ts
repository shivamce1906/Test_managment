import mongoose, { ClientSession } from 'mongoose';
import { logger } from '../utils/logger';
import { env } from './env';

let isConnected = false;
let transactionsSupported: boolean | undefined;

export async function connectDb(uri: string) {
  const mongoUri = uri;

  if (isConnected && mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  try {
    await mongoose.connect(mongoUri, {
      autoIndex: false,
      serverSelectionTimeoutMS: 30000,
    });
    logger.info('MongoDB connected successfully');
    isConnected = true;

    if (env.DB_AUTO_INDEX) {
      await ensureIndexes();
    }

    return mongoose.connection;
  } catch (error) {
    logger.error({ err: error }, '❌ MongoDB connection failed');
    throw error;
  }
}

/**
 * Creates every index declared on the registered models that does not exist yet. A failure on one
 * collection (typically duplicates blocking a unique index) is logged, not fatal.
 */
export async function ensureIndexes(): Promise<{ model: string; error?: string }[]> {
  const results: { model: string; error?: string }[] = [];
  for (const name of mongoose.modelNames()) {
    try {
      await mongoose.model(name).createIndexes();
      results.push({ model: name });
    } catch (err: any) {
      logger.error({ err, model: name }, 'Index build failed');
      results.push({ model: name, error: err?.message || String(err) });
    }
  }
  return results;
}

export async function disconnectDb(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  isConnected = false;
  transactionsSupported = undefined;
  logger.info('MongoDB disconnected');
}

/**
 * Multi-document transactions need a replica set or sharded cluster (Atlas is one).
 * Checked once per connection so a plain standalone mongod keeps working without them.
 */
async function supportsTransactions(): Promise<boolean> {
  if (transactionsSupported === undefined) {
    const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
    transactionsSupported = Boolean(hello.setName) || hello.msg === 'isdbgrid';
    logger.info({ transactionsSupported }, 'MongoDB transaction support detected');
  }
  return transactionsSupported;
}

/**
 * Runs fn inside a transaction when the deployment supports it (replica set / Atlas),
 * otherwise runs it with a plain session (standalone mongod, no atomicity).
 */
export async function withTransaction<T>(
  fn: (session: ClientSession) => Promise<T>,
  existingSession?: ClientSession
): Promise<T> {
  if (existingSession) {
    return fn(existingSession);
  }

  const session = await mongoose.startSession();

  try {
    if (!(await supportsTransactions())) {
      return await fn(session);
    }

    let result!: T;
    await session.withTransaction(
      async () => {
        result = await fn(session);
      },
      {
        readPreference: 'primary',
        readConcern: { level: 'majority' },
        writeConcern: { w: 'majority' },
      }
    );
    return result;
  } finally {
    await session.endSession();
  }
}
