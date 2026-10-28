import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IAdvance extends Document {
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  staffId: Types.ObjectId;
  amountPaise: number;
  date: string;
  recoveryPerMonthPaise: number;
  recoveredPaise: number;
  expenseId?: Types.ObjectId;
  status: 'open' | 'closed';
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const advanceSchema = new Schema<IAdvance>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    staffId: { type: Schema.Types.ObjectId, ref: 'staff', required: true },
    amountPaise: { type: Number, required: true },
    date: { type: String, required: true },
    recoveryPerMonthPaise: { type: Number, required: true },
    recoveredPaise: { type: Number, default: 0, required: true },
    expenseId: { type: Schema.Types.ObjectId, ref: 'expenses' },
    status: { type: String, enum: ['open', 'closed'], default: 'open', required: true },
  },
  {
    collection: 'advances',
  }
);

advanceSchema.plugin(baseFieldsPlugin);
advanceSchema.plugin(tenantScopePlugin);

advanceSchema.index({ businessId: 1, staffId: 1, status: 1 });

export const Advance = model<IAdvance>('advances', advanceSchema);
