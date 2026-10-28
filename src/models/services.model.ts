import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IService extends Document {
  businessId: Types.ObjectId;
  categoryId: Types.ObjectId;
  name: string;
  gender: 'men' | 'women' | 'unisex';
  basePricePaise: number;
  durationMin: number;
  branchPrices: {
    branchId: Types.ObjectId;
    pricePaise?: number;
    active: boolean;
  }[];
  consumables: {
    productId: Types.ObjectId;
    qty: number;
  }[];
  rebookDays?: number;
  eligibleStaffIds: Types.ObjectId[];
  commission?: {
    type: 'pct' | 'fixed' | 'slab';
    value?: number;
    slabs?: { uptoPaise: number; bps: number }[];
  };
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
  __v: number;
}

const serviceSchema = new Schema<IService>(
  {
    categoryId: { type: Schema.Types.ObjectId, ref: 'categories', required: true },
    name: { type: String, required: true },
    gender: { type: String, enum: ['men', 'women', 'unisex'], required: true },
    basePricePaise: { type: Number, required: true },
    durationMin: { type: Number, required: true },
    branchPrices: {
      type: [
        {
          branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
          pricePaise: { type: Number },
          active: { type: Boolean, default: true, required: true },
        },
      ],
      default: [],
    },
    consumables: {
      type: [
        {
          productId: { type: Schema.Types.ObjectId, ref: 'products', required: true },
          qty: { type: Number, required: true },
        },
      ],
      default: [],
    },
    rebookDays: { type: Number },
    eligibleStaffIds: [{ type: Schema.Types.ObjectId, ref: 'staff' }],
    commission: {
      type: { type: String, enum: ['pct', 'fixed', 'slab'] },
      value: { type: Number },
      slabs: [{ uptoPaise: Number, bps: Number }],
    },
    active: { type: Boolean, default: true, required: true },
  },
  {
    collection: 'services',
  }
);

serviceSchema.plugin(baseFieldsPlugin);
serviceSchema.plugin(tenantScopePlugin);

serviceSchema.index({ businessId: 1, categoryId: 1 });
serviceSchema.index({ businessId: 1, active: 1 });

export const Service = model<IService>('services', serviceSchema);
