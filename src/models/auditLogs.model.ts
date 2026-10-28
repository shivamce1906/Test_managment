import { Schema, model, Document, Types } from 'mongoose';

export interface IAuditLog extends Document {
  businessId?: Types.ObjectId;
  branchId?: Types.ObjectId;
  actor: {
    kind: 'platform' | 'tenant' | 'system';
    id?: Types.ObjectId;
    role?: string;
    name: string;
  };
  billedByName?: string;
  action: string;
  entity: string;
  entityId?: Types.ObjectId;
  before?: Record<string, any>;
  after?: Record<string, any>;
  reason?: string;
  ip?: string;
  userAgent?: string;
  at: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'businesses' },
    branchId: { type: Schema.Types.ObjectId, ref: 'branches' },
    actor: {
      kind: { type: String, enum: ['platform', 'tenant', 'system'], required: true },
      id: { type: Schema.Types.ObjectId },
      role: { type: String },
      name: { type: String, required: true },
    },
    billedByName: { type: String },
    action: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: { type: Schema.Types.ObjectId },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    reason: { type: String },
    ip: { type: String },
    userAgent: { type: String },
    at: { type: Date, default: Date.now, required: true },
  },
  {
    collection: 'auditLogs',
    timestamps: false,
  }
);

auditLogSchema.index({ businessId: 1, at: -1 });
auditLogSchema.index({ businessId: 1, entity: 1, entityId: 1 });

const preventMutation = function (this: any, next: (err?: any) => void) {
  next(new Error('Audit logs are append-only and cannot be updated or deleted'));
};

auditLogSchema.pre('updateOne', preventMutation);
auditLogSchema.pre('updateMany', preventMutation);
auditLogSchema.pre('deleteOne', preventMutation);
auditLogSchema.pre('deleteMany', preventMutation);
auditLogSchema.pre('findOneAndUpdate', preventMutation);
auditLogSchema.pre('findOneAndDelete', preventMutation);
auditLogSchema.pre('findOneAndReplace', preventMutation);
auditLogSchema.pre('save', function (this: any, next) {
  if (!this.isNew) {
    return next(new Error('Audit logs are append-only and cannot be updated'));
  }
  next();
});

export const AuditLog = model<IAuditLog>('auditLogs', auditLogSchema);
