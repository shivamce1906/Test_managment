import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IWalletLedger extends Document {
  businessId: Types.ObjectId;
  customerId: Types.ObjectId;
  branchId?: Types.ObjectId;
  type: 'topup' | 'bonus' | 'redeem' | 'refund' | 'reverse' | 'expiry' | 'adjust' | 'imported';
  amountPaise: number;
  billId?: Types.ObjectId;
  reason?: string;
  balanceAfterPaise: number;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const walletLedgerSchema = new Schema<IWalletLedger>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'customers', required: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'branches' },
    type: {
      type: String,
      enum: ['topup', 'bonus', 'redeem', 'refund', 'reverse', 'expiry', 'adjust', 'imported'],
      required: true,
    },
    amountPaise: { type: Number, required: true },
    billId: { type: Schema.Types.ObjectId, ref: 'bills' },
    reason: { type: String },
    balanceAfterPaise: { type: Number, required: true },
  },
  {
    collection: 'walletLedger',
  }
);

walletLedgerSchema.plugin(baseFieldsPlugin);
walletLedgerSchema.plugin(tenantScopePlugin);

walletLedgerSchema.index({ businessId: 1, customerId: 1, createdAt: -1 });

export const WalletLedger = model<IWalletLedger>('walletLedger', walletLedgerSchema);
