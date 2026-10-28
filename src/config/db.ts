import mongoose, { ClientSession } from 'mongoose';
import { logger } from '../utils/logger';
import '../models'; // Ensure all model schemas are registered for index syncing

let isConnected = false;

/** Builds every index declared on the Mongoose schemas */
export async function syncAllIndexes(): Promise<void> {
  const modelNames = mongoose.modelNames();
  for (const name of modelNames) {
    try {
      await mongoose.model(name).syncIndexes();
    } catch (err) {
      logger.warn({ model: name, err }, 'Failed to sync indexes for model');
    }
  }
}

export async function connectDb(uri: string) {
  const mongoUri = uri;

  if (isConnected && mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  try {
    await mongoose.connect(mongoUri, {
      autoIndex: true,
      serverSelectionTimeoutMS: 30000,
    });
    logger.info('MongoDB connected successfully');
    isConnected = true;

    // Sync all declared unique and composite indexes on startup
    await syncAllIndexes();

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
  logger.info('MongoDB disconnected');
}

/**
 * Executes a MongoDB database operation inside a multi-document ACID transaction.
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

