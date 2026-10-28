import { Request, Response, NextFunction } from 'express';
import {
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getChanges,
} from '../services';
import { s3Adapter } from '../integrations';
import { randomUUID } from 'crypto';

export class NotificationController {
  public static async getNotifications(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await getNotifications(req.ctx);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async markRead(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await markNotificationRead(req.ctx, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async markAllRead(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await markAllNotificationsRead(req.ctx);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async getChanges(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const scopesRaw = (req.query.scopes as string) || '';
      const scopes = scopesRaw.split(',').filter(Boolean);
      const sinceRaw = (req.query.since as string) || '{}';
      let since = {};
      try {
        since = JSON.parse(sinceRaw);
      } catch (e) {
        since = {};
      }

      const result = await getChanges(req.ctx, scopes as any, since);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  public static async presignUpload(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { filename, contentType } = req.body;
      const extension = filename ? filename.split('.').pop() : 'bin';
      const key = `uploads/${req.ctx.businessId || 'platform'}/${Date.now()}-${randomUUID()}.${extension}`;
      const presignedUrl = await s3Adapter.getPresignedPutUrl(key, contentType || 'application/octet-stream');

      res.json({
        key,
        uploadUrl: presignedUrl,
      });
    } catch (err) {
      next(err);
    }
  }
}
