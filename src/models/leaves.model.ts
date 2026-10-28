import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface ILeave extends Document {
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  staffId: Types.ObjectId;
  from: string;
  to: string;
  type: 'paid' | 'unpaid';
  status: 'approved' | 'rejected';
  reason?: string;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const leaveSchema = new Schema<ILeave>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    staffId: { type: Schema.Types.ObjectId, ref: 'staff', required: true },
    from: { type: String, required: true },
    to: { type: String, required: true },
    type: { type: String, enum: ['paid', 'unpaid'], required: true },
    status: { type: String, enum: ['approved', 'rejected'], default: 'approved', required: true },
    reason: { type: String },
  },
  {
    collection: 'leaves',
  }
);

leaveSchema.plugin(baseFieldsPlugin);
leaveSchema.plugin(tenantScopePlugin);

leaveSchema.index({ businessId: 1, staffId: 1, from: 1 });

export const Leave = model<ILeave>('leaves', leaveSchema);
