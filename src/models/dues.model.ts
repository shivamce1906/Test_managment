import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IDueSettlement {
  billId?: Types.ObjectId;
  receiptId?: Types.ObjectId;
  amountPaise: number;
  at: Date;
}

export interface IDue extends Document {
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  customerId: Types.ObjectId;
  billId: Types.ObjectId;
  amountPaise: number;
  settledPaise: number;
  status: 'open' | 'settled' | 'void';
  settlements: IDueSettlement[];
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const dueSchema = new Schema<IDue>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'customers', required: true },
    billId: { type: Schema.Types.ObjectId, ref: 'bills', required: true },
    amountPaise: { type: Number, required: true },
    settledPaise: { type: Number, default: 0, required: true },
    status: { type: String, enum: ['open', 'settled', 'void'], default: 'open', required: true },
    settlements: [
      {
        billId: { type: Schema.Types.ObjectId, ref: 'bills' },
        receiptId: { type: Schema.Types.ObjectId, ref: 'dueReceipts' },
        amountPaise: { type: Number, required: true },
        at: { type: Date, default: Date.now, required: true },
      },
    ],
  },
  {
    collection: 'dues',
  }
);

dueSchema.plugin(baseFieldsPlugin);
dueSchema.plugin(tenantScopePlugin);

dueSchema.index({ businessId: 1, customerId: 1, status: 1 });
dueSchema.index({ businessId: 1, billId: 1 });

export const Due = model<IDue>('dues', dueSchema);
