import mongoose, { ClientSession } from 'mongoose';
import { logger } from '../utils/logger';

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

    return mongoose.connection;
  } catch (error) {
    logger.error({ err: error }, '❌ MongoDB connection failed');
    throw error;
  }
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
