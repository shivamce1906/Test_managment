import mongoose, { ClientSession } from 'mongoose';
import { logger } from '../utils/logger';

let isConnected = false;

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
    logger.info('MongoDB connected successfully (Normal Standalone Mode)');
    isConnected = true;

    /*
    // =========================================================================
    // REPLICA SET TOPOLOGY CHECK (Uncomment when deploying to a Replica Set cluster)
    // =========================================================================
    // const adminDb = mongoose.connection.db?.admin();
    // if (adminDb) {
    //   const hello = await adminDb.command({ hello: 1 });
    //   if (hello.setName || hello.hosts) {
    //     logger.info({ replicaSet: hello.setName }, '✅ MongoDB Replica Set active with transaction support');
    //   }
    // }
    // =========================================================================
    */

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
 * Executes a MongoDB database operation.
 * Active Mode: Normal standalone MongoDB (runs smoothly without replica set requirement).
 * Replica Mode: Multi-document ACID transactions preserved below (uncomment for replica clusters/Atlas).
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
    /*
    // =========================================================================
    // REPLICA SET TRANSACTION CODE (PRESERVED)
    // Uncomment this block when deploying to a MongoDB Replica Set or MongoDB Atlas:
    // =========================================================================
    // let result!: T;
    // await session.withTransaction(
    //   async () => {
    //     result = await fn(session);
    //   },
    //   {
    //     readPreference: 'primary',
    //     readConcern: { level: 'majority' },
    //     writeConcern: { w: 'majority' },
    //   }
    // );
    // return result;
    // =========================================================================
    */

    // NORMAL STANDALONE MONGODB EXECUTION
    // Runs cleanly and smoothly on any standard single-node or local MongoDB installation:
    return await fn(session);
  } finally {
    await session.endSession();
  }
}

