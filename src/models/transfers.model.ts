import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface ITransferItem {
  productId: Types.ObjectId;
  pool: 'retail' | 'consumable';
  qty: number;
  receivedQty?: number;
  mismatchReason?: string;
}

export interface ITransfer extends Document {
  businessId: Types.ObjectId;
  transferNo: string;
  fromBranchId: Types.ObjectId;
  toBranchId: Types.ObjectId;
  items: ITransferItem[];
  status: 'requested' | 'approved' | 'dispatched' | 'received' | 'rejected' | 'cancelled';
  log: {
    action: string;
    by: Types.ObjectId;
    at: Date;
    reason?: string;
  }[];
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const transferSchema = new Schema<ITransfer>(
  {
    transferNo: { type: String, required: true },
    fromBranchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    toBranchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    items: [
      {
        productId: { type: Schema.Types.ObjectId, ref: 'products', required: true },
        pool: { type: String, enum: ['retail', 'consumable'], required: true },
        qty: { type: Number, required: true },
        receivedQty: { type: Number },
        mismatchReason: { type: String },
      },
    ],
    status: {
      type: String,
      enum: ['requested', 'approved', 'dispatched', 'received', 'rejected', 'cancelled'],
      default: 'requested',
      required: true,
    },
    log: [
      {
        action: { type: String, required: true },
        by: { type: Schema.Types.ObjectId, ref: 'users', required: true },
        at: { type: Date, default: Date.now, required: true },
        reason: { type: String },
      },
    ],
  },
  {
    collection: 'transfers',
  }
);

transferSchema.plugin(baseFieldsPlugin);
transferSchema.plugin(tenantScopePlugin);

transferSchema.index({ businessId: 1, status: 1, createdAt: -1 });
transferSchema.index({ businessId: 1, transferNo: 1 }, { unique: true });

export const Transfer = model<ITransfer>('transfers', transferSchema);
