import { Types } from 'mongoose';

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
  return typeof id === 'string' ? new Types.ObjectId(id) : id;
}
