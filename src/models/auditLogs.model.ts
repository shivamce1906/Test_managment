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

// Append-only (PRD §16): entries are inserted and read, never changed or removed through the app.
const APPEND_ONLY_ERROR = 'Audit log entries are append-only';
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  auditLogSchema.pre(op, function () {
    throw new Error(APPEND_ONLY_ERROR);
  });
}
auditLogSchema.pre('save', function () {
  if (!this.isNew) throw new Error(APPEND_ONLY_ERROR);
});
auditLogSchema.pre('deleteOne', { document: true, query: false }, function () {
  throw new Error(APPEND_ONLY_ERROR);
});

auditLogSchema.index({ businessId: 1, at: -1 });
auditLogSchema.index({ businessId: 1, entity: 1, entityId: 1 });

export const AuditLog = model<IAuditLog>('auditLogs', auditLogSchema);
