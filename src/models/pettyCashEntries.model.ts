import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IPettyCashEntry extends Document {
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  businessDate: string;
  type: 'float' | 'topup' | 'expense' | 'deposit';
  amountPaise: number;
  refId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const pettyCashEntrySchema = new Schema<IPettyCashEntry>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    businessDate: { type: String, required: true },
    type: { type: String, enum: ['float', 'topup', 'expense', 'deposit'], required: true },
    amountPaise: { type: Number, required: true },
    refId: { type: Schema.Types.ObjectId, ref: 'expenses' },
  },
  {
    collection: 'pettyCashEntries',
  }
);

pettyCashEntrySchema.plugin(baseFieldsPlugin);
pettyCashEntrySchema.plugin(tenantScopePlugin);

pettyCashEntrySchema.index({ businessId: 1, branchId: 1, businessDate: -1 });

export const PettyCashEntry = model<IPettyCashEntry>('pettyCashEntries', pettyCashEntrySchema);
