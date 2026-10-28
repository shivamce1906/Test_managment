import { Types } from 'mongoose';
import { AppError, ErrorCode } from '../utils';

export interface RequestContext {
  businessId?: string; // Tenant ID (empty for platform superadmin)
  branchId?: string; // Active branch for the request
  userId: string;
  role: 'super_admin' | 'superadmin' | 'owner' | 'manager' | 'branch';
  kind: 'platform' | 'tenant';
  name: string;
  email?: string;
  branchIds: string[]; // Branches assigned to user (empty for owner = all)
  flags?: Record<string, any>;
  billedBy?: string; // For branch logins, the receptionist chosen on bill
  ip?: string;
  userAgent?: string;
  reqId?: string;
}

export function toObjectId(id: string | Types.ObjectId): Types.ObjectId {
  if (!id) {
    throw new AppError(400, ErrorCode.BAD_REQUEST, 'Invalid ID format: empty ID');
  }
  if (typeof id === 'string') {
    if (!Types.ObjectId.isValid(id) || id.length !== 24) {
      throw new AppError(400, ErrorCode.BAD_REQUEST, `Invalid ID format: ${id}`);
    }
    return new Types.ObjectId(id);
  }
  return id;
}
