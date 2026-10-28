import { Types } from 'mongoose';
import { Notification } from '../models';
import { AppError, ErrorCode } from '../utils';
import { RequestContext } from './context';
import { getRedisClient } from '../integrations';

export type ChangeScope =
  | 'appointments'
  | 'bills'
  | 'stock'
  | 'whatsapp'
  | 'roster'
  | 'approvals'
  | 'customers'
  | (string & {});

export async function createNotification(input: {
  businessId: Types.ObjectId;
  userId: Types.ObjectId;
  type: string;
  title: string;
  body: string;
  link?: string;
}) {
  return Notification.create({
    businessId: input.businessId,
    userId: input.userId,
    type: input.type,
    title: input.title,
    body: input.body,
    link: input.link,
    createdAt: new Date(),
  });
}

export async function getNotifications(
  ctx: RequestContext,
  limit = 50,
  unreadOnly = false
) {
  const query: any = { userId: ctx.userId };
  if (unreadOnly) {
    query.readAt = { $exists: false };
  }

  return Notification.find(query).sort({ createdAt: -1 }).limit(limit);
}

export async function markNotificationRead(
  ctx: RequestContext,
  notificationId: string | Types.ObjectId
) {
  const notif = await Notification.findOneAndUpdate(
    { _id: notificationId, userId: ctx.userId },
    { $set: { readAt: new Date() } },
    { new: true }
  );

  if (!notif) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Notification not found');
  }

  return notif;
}

export async function markAllNotificationsRead(ctx: RequestContext) {
  await Notification.updateMany(
    { userId: ctx.userId, readAt: { $exists: false } },
    { $set: { readAt: new Date() } }
  );

  return { success: true };
}

// ----------------------------------------------------
// Redis Scope Counters for Polling /changes
// ----------------------------------------------------

export async function bumpScopeCounter(
  businessId: Types.ObjectId | string,
  scope: ChangeScope
) {
  const redis = getRedisClient();
  const key = `chg:${businessId.toString()}:${scope}`;
  return redis.incr(key);
}

export async function getChanges(
  ctx: RequestContext,
  scopes: ChangeScope[],
  since: Record<string, number> = {}
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const redis = getRedisClient();
  const changes: Record<string, { changed: boolean; version: number }> = {};

  for (const scope of scopes) {
    const key = `chg:${ctx.businessId.toString()}:${scope}`;
    const raw = await redis.get(key);
    const currentVersion = raw ? parseInt(raw, 10) : 0;
    const clientVersion = since[scope] || 0;

    changes[scope] = {
      changed: currentVersion > clientVersion,
      version: currentVersion,
    };
  }

  return changes;
}

export const notificationService = {
  createNotification,
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  bumpScopeCounter,
  bumpScope: bumpScopeCounter,
  getChanges,
};

