import { ClientSession, Types } from 'mongoose';
import { AuditLog, IAuditLog } from '../models';
import { RequestContext, toObjectId } from './context';
import { AppError } from '../utils';
import ExcelJS from 'exceljs';

export interface LogActionParams {
  ctx?: RequestContext;
  businessId?: Types.ObjectId | string;
  branchId?: Types.ObjectId | string;
  actorId?: Types.ObjectId | string;
  actorRole?: string;
  action: string;
  entity?: string;
  entityId?: Types.ObjectId | string;
  targetType?: string;
  targetId?: Types.ObjectId | string;
  before?: Record<string, any>;
  after?: Record<string, any>;
  reason?: string;
  meta?: Record<string, any>;
  billedByName?: string;
  session?: ClientSession;
}

export async function logAction(params: LogActionParams): Promise<void> {
  const {
    ctx,
    businessId,
    branchId,
    actorId,
    actorRole,
    action,
    entity,
    entityId,
    targetType,
    targetId,
    before,
    after,
    reason,
    meta,
    billedByName,
    session,
  } = params;

  const bId = businessId || ctx?.businessId;
  const brId = branchId || ctx?.branchId || (ctx?.branchIds && ctx.branchIds.length === 1 ? ctx.branchIds[0] : undefined);
  const actId = actorId || ctx?.userId;
  const actRole = actorRole || ctx?.role || 'system';
  const ent = entity || targetType || 'unknown';
  const entId = entityId || targetId;

  const logEntry = new AuditLog({
    businessId: bId ? toObjectId(bId) : undefined,
    branchId: brId ? toObjectId(brId) : undefined,
    actor: {
      kind: ctx?.kind || 'tenant',
      id: actId ? toObjectId(actId) : new Types.ObjectId(),
      role: actRole,
      name: ctx?.name || actRole,
    },
    billedByName: billedByName || ctx?.billedBy,
    action,
    entity: ent,
    entityId: entId ? toObjectId(entId) : undefined,
    before,
    after,
    reason,
    meta,
    ip: ctx?.ip,
    userAgent: ctx?.userAgent,
    at: new Date(),
  });

  await logEntry.save({ session });
}

export async function queryAuditLogs(
  ctx: RequestContext,
  filters: {
    from?: string;
    to?: string;
    branchId?: string;
    userId?: string;
    action?: string;
    entity?: string;
    entityId?: string;
    page?: number;
    limit?: number;
  }
): Promise<{ logs: IAuditLog[]; total: number }> {
  const query: any = {};

  if (ctx.role === 'superadmin' || ctx.role === 'super_admin') {
    if (ctx.businessId) {
      query.businessId = toObjectId(ctx.businessId);
    }
  } else {
    if (!ctx.businessId) {
      throw new AppError(403, 'FORBIDDEN', 'Tenant context required');
    }
    query.businessId = toObjectId(ctx.businessId);

    // Manager can only view assigned branches
    if (ctx.role === 'manager') {
      const allowedBranches = ctx.branchIds.map(toObjectId);
      if (filters.branchId) {
        if (!ctx.branchIds.includes(filters.branchId)) {
          throw new AppError(403, 'FORBIDDEN', 'Access to branch audit logs denied');
        }
        query.branchId = toObjectId(filters.branchId);
      } else {
        query.branchId = { $in: allowedBranches };
      }
    } else if (ctx.role === 'branch') {
      throw new AppError(403, 'FORBIDDEN', 'Branch login cannot view audit logs');
    } else if (filters.branchId) {
      query.branchId = toObjectId(filters.branchId);
    }
  }

  if (filters.userId) query['actor.id'] = toObjectId(filters.userId);
  if (filters.action) query.action = filters.action;
  if (filters.entity) query.entity = filters.entity;
  if (filters.entityId) query.entityId = toObjectId(filters.entityId);

  if (filters.from || filters.to) {
    query.at = {};
    if (filters.from) query.at.$gte = new Date(filters.from);
    if (filters.to) query.at.$lte = new Date(filters.to + 'T23:59:59.999Z');
  }

  const page = Math.max(1, filters.page || 1);
  const limit = Math.min(100, Math.max(1, filters.limit || 25));
  const skip = (page - 1) * limit;

  const [logs, total] = await Promise.all([
    AuditLog.find(query).sort({ at: -1 }).skip(skip).limit(limit),
    AuditLog.countDocuments(query),
  ]);

  return { logs, total };
}

export async function exportAuditLogs(ctx: RequestContext, filters: any): Promise<Buffer> {
  if (ctx.role !== 'owner' && ctx.role !== 'superadmin' && ctx.role !== 'super_admin') {
    throw new AppError(403, 'FORBIDDEN', 'Only owner or superadmin can export audit logs');
  }

  const { logs } = await queryAuditLogs(ctx, { ...filters, limit: 5000, page: 1 });

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Audit Log');

  worksheet.columns = [
    { header: 'Timestamp (UTC)', key: 'at', width: 22 },
    { header: 'Actor Name', key: 'actorName', width: 20 },
    { header: 'Actor Role', key: 'actorRole', width: 15 },
    { header: 'Billed By', key: 'billedByName', width: 15 },
    { header: 'Action', key: 'action', width: 25 },
    { header: 'Entity', key: 'entity', width: 15 },
    { header: 'Entity ID', key: 'entityId', width: 26 },
    { header: 'Reason', key: 'reason', width: 30 },
    { header: 'IP', key: 'ip', width: 15 },
  ];

  logs.forEach((log) => {
    worksheet.addRow({
      at: log.at.toISOString(),
      actorName: log.actor.name,
      actorRole: log.actor.role,
      billedByName: log.billedByName || '',
      action: log.action,
      entity: log.entity,
      entityId: log.entityId?.toString() || '',
      reason: log.reason || '',
      ip: log.ip || '',
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export class AuditService {
  logAction = logAction;
  queryAuditLogs = queryAuditLogs;
  exportAuditLogs = exportAuditLogs;
}

export const auditService = new AuditService();
