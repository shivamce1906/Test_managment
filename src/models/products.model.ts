import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IProduct extends Document {
  businessId: Types.ObjectId;
  name: string;
  brand?: string;
  category?: string;
  type: 'retail' | 'consumable' | 'both';
  sku?: string;
  purchaseUnit: string;
  useUnit: string;
  unitsPerPurchase: number;
  mrpPaise?: number;
  sellingPricePaise?: number;
  purchasePricePaise: number;
  hsn?: string;
  gstBps?: number;
  reorderLevels: {
    branchId: Types.ObjectId;
    qty: number;
  }[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
  __v: number;
}

const productSchema = new Schema<IProduct>(
  {
    name: { type: String, required: true },
    brand: { type: String },
    category: { type: String },
    type: { type: String, enum: ['retail', 'consumable', 'both'], required: true },
    sku: { type: String },
    purchaseUnit: { type: String, required: true },
    useUnit: { type: String, required: true },
    unitsPerPurchase: { type: Number, required: true },
    mrpPaise: { type: Number },
    sellingPricePaise: { type: Number },
    purchasePricePaise: { type: Number, required: true },
    hsn: { type: String },
    gstBps: { type: Number },
    reorderLevels: {
      type: [
        {
          branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
          qty: { type: Number, required: true },
        },
      ],
      default: [],
    },
    active: { type: Boolean, default: true, required: true },
  },
  {
    collection: 'products',
  }
);

productSchema.plugin(baseFieldsPlugin);
productSchema.plugin(tenantScopePlugin);

productSchema.index({ businessId: 1, type: 1 });
productSchema.index({ businessId: 1, active: 1 });
productSchema.index({ businessId: 1, sku: 1 }, { sparse: true });

export const Product = model<IProduct>('products', productSchema);
