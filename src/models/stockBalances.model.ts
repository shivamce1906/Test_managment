import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IStockBalance extends Document {
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  productId: Types.ObjectId;
  pool: 'retail' | 'consumable';
  qty: number;
  lastMovementAt: Date;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const stockBalanceSchema = new Schema<IStockBalance>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'products', required: true },
    pool: { type: String, enum: ['retail', 'consumable'], required: true },
    qty: { type: Number, default: 0, required: true },
    lastMovementAt: { type: Date, default: Date.now, required: true },
  },
  {
    collection: 'stockBalances',
  }
);

stockBalanceSchema.plugin(baseFieldsPlugin);
stockBalanceSchema.plugin(tenantScopePlugin);

stockBalanceSchema.index({ businessId: 1, branchId: 1, productId: 1, pool: 1 }, { unique: true });

export const StockBalance = model<IStockBalance>('stockBalances', stockBalanceSchema);
