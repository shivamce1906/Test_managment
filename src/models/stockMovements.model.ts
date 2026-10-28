import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IStockMovement extends Document {
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  productId: Types.ObjectId;
  pool: 'retail' | 'consumable';
  type: 'purchase' | 'sale' | 'service_use' | 'transfer_out' | 'transfer_in' | 'adjust' | 'internal_use' | 'cancel_reverse' | 'audit' | 'imported';
  qty: number;
  costPaise: number;
  refType?: string;
  refId?: Types.ObjectId;
  reason?: string;
  batch?: string;
  expiry?: string;
  businessDate: string;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const stockMovementSchema = new Schema<IStockMovement>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'products', required: true },
    pool: { type: String, enum: ['retail', 'consumable'], required: true },
    type: {
      type: String,
      enum: ['purchase', 'sale', 'service_use', 'transfer_out', 'transfer_in', 'adjust', 'internal_use', 'cancel_reverse', 'audit', 'imported'],
      required: true,
    },
    qty: { type: Number, required: true },
    costPaise: { type: Number, default: 0, required: true },
    refType: { type: String },
    refId: { type: Schema.Types.ObjectId },
    reason: { type: String },
    batch: { type: String },
    expiry: { type: String },
    businessDate: { type: String, required: true },
  },
  {
    collection: 'stockMovements',
  }
);

stockMovementSchema.plugin(baseFieldsPlugin);
stockMovementSchema.plugin(tenantScopePlugin);

stockMovementSchema.index({ businessId: 1, branchId: 1, productId: 1, createdAt: -1 });

export const StockMovement = model<IStockMovement>('stockMovements', stockMovementSchema);
