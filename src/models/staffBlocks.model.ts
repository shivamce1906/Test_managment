import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IStaffBlock extends Document {
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  staffId: Types.ObjectId;
  start: Date;
  end: Date;
  reason: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
  __v: number;
}

const staffBlockSchema = new Schema<IStaffBlock>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    staffId: { type: Schema.Types.ObjectId, ref: 'staff', required: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    reason: { type: String, required: true },
  },
  {
    collection: 'staffBlocks',
  }
);

staffBlockSchema.plugin(baseFieldsPlugin);
staffBlockSchema.plugin(tenantScopePlugin);

staffBlockSchema.index({ businessId: 1, staffId: 1, start: 1 });

export const StaffBlock = model<IStaffBlock>('staffBlocks', staffBlockSchema);
