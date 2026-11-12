import { Request, Response, NextFunction } from 'express';
import {
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getChanges,
} from '../services';
import { s3Adapter } from '../integrations';
import { AppError, ErrorCode } from '../utils';
import { randomUUID } from 'crypto';

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
};

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
      const { kind, filename, contentType } = req.body;
      const normalizedCt = String(contentType || '').toLowerCase();
      const defaultExt = EXT_BY_CONTENT_TYPE[normalizedCt];
      if (!defaultExt) {
        throw new AppError(400, ErrorCode.VALIDATION_ERROR, `Disallowed upload contentType: ${contentType}`);
      }

      const rawExt = filename && typeof filename === 'string' && filename.includes('.')
        ? filename.split('.').pop()!.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
        : '';
      const extension = rawExt || defaultExt;
      const folder = kind ? String(kind).replace(/[^a-zA-Z0-9_-]/g, '') : 'uploads';
      const key = `${folder}/${req.ctx.businessId || 'platform'}/${Date.now()}-${randomUUID()}.${extension}`;
      const url = await s3Adapter.getPresignedPutUrl(key, normalizedCt);

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
