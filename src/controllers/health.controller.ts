import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { getRedisClient } from '../integrations';
import { areWorkersRunning } from '../workers';

export class HealthController {
  public static getHealth(req: Request, res: Response): void {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      workersActive: areWorkersRunning(),
    });
  }

  public static async getReady(req: Request, res: Response): Promise<void> {
    const mongoStatus = mongoose.connection.readyState === 1 ? 'ready' : 'disconnected';
    let redisStatus = 'ready';
    try {
      const redis = getRedisClient();
      await redis.ping();
    } catch (err) {
      redisStatus = 'disconnected';
    }

    const isReady = mongoStatus === 'ready' && redisStatus === 'ready';
    res.status(isReady ? 200 : 503).json({
      status: isReady ? 'ready' : 'unhealthy',
      mongo: mongoStatus,
      redis: redisStatus,
      workersActive: areWorkersRunning(),
    });
  }
}
