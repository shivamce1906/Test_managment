import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface ILoyaltyLedger extends Document {
  businessId: Types.ObjectId;
  customerId: Types.ObjectId;
  type: 'earn' | 'redeem' | 'reverse' | 'expiry' | 'adjust' | 'imported';
  points: number;
  billId?: Types.ObjectId;
  balanceAfter: number;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const loyaltyLedgerSchema = new Schema<ILoyaltyLedger>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'customers', required: true },
    type: {
      type: String,
      enum: ['earn', 'redeem', 'reverse', 'expiry', 'adjust', 'imported'],
      required: true,
    },
    points: { type: Number, required: true },
    billId: { type: Schema.Types.ObjectId, ref: 'bills' },
    balanceAfter: { type: Number, required: true },
  },
  {
    collection: 'loyaltyLedger',
  }
);

loyaltyLedgerSchema.plugin(baseFieldsPlugin);
loyaltyLedgerSchema.plugin(tenantScopePlugin);

loyaltyLedgerSchema.index({ businessId: 1, customerId: 1, createdAt: -1 });

export const LoyaltyLedger = model<ILoyaltyLedger>('loyaltyLedger', loyaltyLedgerSchema);
