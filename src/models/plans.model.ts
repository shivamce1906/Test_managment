import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IPlan extends Document {
  businessId: Types.ObjectId;
  type: 'membership' | 'package' | 'wallet_offer' | 'voucher';
  name: string;
  pricePaise: number;
  validityDays: number;
  membership?: {
    serviceDiscountBps: number;
    productDiscountBps: number;
  };
  package?: {
    items: {
      serviceId: Types.ObjectId;
      sessions: number;
    }[];
  };
  walletOffer?: {
    creditPaise: number;
  };
  voucher?: {
    valuePaise: number;
  };
  branchScope: Types.ObjectId[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
  __v: number;
}

const planSchema = new Schema<IPlan>(
  {
    type: { type: String, enum: ['membership', 'package', 'wallet_offer', 'voucher'], required: true },
    name: { type: String, required: true },
    pricePaise: { type: Number, required: true },
    validityDays: { type: Number, required: true },
    membership: {
      serviceDiscountBps: { type: Number, default: 0 },
      productDiscountBps: { type: Number, default: 0 },
    },
    package: {
      items: [
        {
          serviceId: { type: Schema.Types.ObjectId, ref: 'services', required: true },
          sessions: { type: Number, required: true },
        },
      ],
    },
    walletOffer: {
      creditPaise: { type: Number },
    },
    voucher: {
      valuePaise: { type: Number },
    },
    branchScope: [{ type: Schema.Types.ObjectId, ref: 'branches' }],
    active: { type: Boolean, default: true, required: true },
  },
  {
    collection: 'plans',
  }
);

planSchema.plugin(baseFieldsPlugin);
planSchema.plugin(tenantScopePlugin);

planSchema.index({ businessId: 1, type: 1 });
planSchema.index({ businessId: 1, active: 1 });

export const Plan = model<IPlan>('plans', planSchema);
