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
      const ALLOWED_UPLOAD_TYPES = new Set([
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
        'text/csv',
        'text/plain',
      ]);

      if (!contentType || !ALLOWED_UPLOAD_TYPES.has(contentType)) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Disallowed or invalid contentType for upload',
          },
        });
        return;
      }

      const extension = filename ? filename.split('.').pop() : 'bin';
      const key = `uploads/${req.ctx.businessId || 'platform'}/${Date.now()}-${randomUUID()}.${extension}`;
      const { url } = await s3Adapter.getPresignedUploadUrl(key, contentType);

      res.json({
        key,
        url,
        uploadUrl: url,
      });
    } catch (err) {
      next(err);
    }
  }
}
