import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IStockAuditLine {
  productId: Types.ObjectId;
  systemQty: number;
  countedQty?: number;
}

export interface IStockAudit extends Document {
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  pool: 'retail' | 'consumable';
  status: 'counting' | 'submitted' | 'approved';
  lines: IStockAuditLine[];
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const stockAuditSchema = new Schema<IStockAudit>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    pool: { type: String, enum: ['retail', 'consumable'], required: true },
    status: { type: String, enum: ['counting', 'submitted', 'approved'], default: 'counting', required: true },
    lines: [
      {
        productId: { type: Schema.Types.ObjectId, ref: 'products', required: true },
        systemQty: { type: Number, required: true },
        countedQty: { type: Number },
      },
    ],
  },
  {
    collection: 'stockAudits',
  }
);

stockAuditSchema.plugin(baseFieldsPlugin);
stockAuditSchema.plugin(tenantScopePlugin);

stockAuditSchema.index({ businessId: 1, branchId: 1, createdAt: -1 });

export const StockAudit = model<IStockAudit>('stockAudits', stockAuditSchema);
