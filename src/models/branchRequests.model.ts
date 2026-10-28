import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IBranchRequest extends Document {
  businessId: Types.ObjectId;
  type: 'add' | 'delete';
  branchId?: Types.ObjectId;
  payload?: {
    name: string;
    address: {
      line1: string;
      line2?: string;
      city: string;
      state: string;
      pincode: string;
    };
  };
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  handledBy?: Types.ObjectId;
  handledAt?: Date;
  rejectReason?: string;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const branchRequestSchema = new Schema<IBranchRequest>(
  {
    type: { type: String, enum: ['add', 'delete'], required: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'branches' },
    payload: {
      name: { type: String },
      address: {
        line1: { type: String },
        line2: { type: String },
        city: { type: String },
        state: { type: String },
        pincode: { type: String },
      },
    },
    reason: { type: String, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', required: true },
    handledBy: { type: Schema.Types.ObjectId, ref: 'platformAdmins' },
    handledAt: { type: Date },
    rejectReason: { type: String },
  },
  {
    collection: 'branchRequests',
  }
);

branchRequestSchema.plugin(baseFieldsPlugin);
branchRequestSchema.plugin(tenantScopePlugin);

branchRequestSchema.index({ businessId: 1, status: 1 });

export const BranchRequest = model<IBranchRequest>('branchRequests', branchRequestSchema);
