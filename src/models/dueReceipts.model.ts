import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IDueReceipt extends Document {
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  customerId: Types.ObjectId;
  receiptNo: string;
  businessDate: string;
  payments: {
    mode: 'cash' | 'upi' | 'card';
    amountPaise: number;
    tenderedPaise?: number;
  }[];
  allocations: {
    dueId: Types.ObjectId;
    amountPaise: number;
  }[];
  status: 'active' | 'cancelled';
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const dueReceiptSchema = new Schema<IDueReceipt>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'customers', required: true },
    receiptNo: { type: String, required: true },
    businessDate: { type: String, required: true },
    payments: [
      {
        mode: { type: String, enum: ['cash', 'upi', 'card'], required: true },
        amountPaise: { type: Number, required: true },
        tenderedPaise: { type: Number },
      },
    ],
    allocations: [
      {
        dueId: { type: Schema.Types.ObjectId, ref: 'dues', required: true },
        amountPaise: { type: Number, required: true },
      },
    ],
    status: { type: String, enum: ['active', 'cancelled'], default: 'active', required: true },
  },
  {
    collection: 'dueReceipts',
  }
);

dueReceiptSchema.plugin(baseFieldsPlugin);
dueReceiptSchema.plugin(tenantScopePlugin);

dueReceiptSchema.index({ businessId: 1, receiptNo: 1 }, { unique: true });
dueReceiptSchema.index({ businessId: 1, branchId: 1, businessDate: 1 });

export const DueReceipt = model<IDueReceipt>('dueReceipts', dueReceiptSchema);
