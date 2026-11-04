import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IMarketingOffer extends Document {
  businessId: Types.ObjectId;
  code: string;
  title: string;
  description?: string;
  offerType: 'festival' | 'special_discount' | 'segment_exclusive' | 'general';
  discountType: 'percentage' | 'flat';
  discountValue: number; // bps for percentage (e.g. 2000 = 20%), or paise for flat amount
  maxDiscountPaise?: number;
  minBillAmountPaise?: number;
  applicableTo: {
    all: boolean;
    serviceIds: Types.ObjectId[];
    categoryIds: Types.ObjectId[];
    productIds: Types.ObjectId[];
  };
  targetSegmentId?: Types.ObjectId;
  validFrom: Date;
  validTill: Date;
  usageLimitPerCustomer: number;
  totalUsageLimit?: number;
  totalUsedCount: number;
  branchScope: Types.ObjectId[];
  active: boolean;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const marketingOfferSchema = new Schema<IMarketingOffer>(
  {
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    title: { type: String, required: true },
    description: { type: String },
    offerType: {
      type: String,
      enum: ['festival', 'special_discount', 'segment_exclusive', 'general'],
      default: 'festival',
      required: true,
    },
    discountType: {
      type: String,
      enum: ['percentage', 'flat'],
      required: true,
    },
    discountValue: { type: Number, required: true },
    maxDiscountPaise: { type: Number },
    minBillAmountPaise: { type: Number, default: 0 },
    applicableTo: {
      all: { type: Boolean, default: true },
      serviceIds: [{ type: Schema.Types.ObjectId, ref: 'services' }],
      categoryIds: [{ type: Schema.Types.ObjectId, ref: 'categories' }],
      productIds: [{ type: Schema.Types.ObjectId, ref: 'products' }],
    },
    targetSegmentId: { type: Schema.Types.ObjectId, ref: 'marketingSegments' },
    validFrom: { type: Date, required: true },
    validTill: { type: Date, required: true },
    usageLimitPerCustomer: { type: Number, default: 1 },
    totalUsageLimit: { type: Number },
    totalUsedCount: { type: Number, default: 0 },
    branchScope: [{ type: Schema.Types.ObjectId, ref: 'branches' }],
    active: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'users' },
  },
  {
    collection: 'marketingOffers',
  }
);

marketingOfferSchema.plugin(baseFieldsPlugin);
marketingOfferSchema.plugin(tenantScopePlugin);

marketingOfferSchema.index({ businessId: 1, code: 1 }, { unique: true });
marketingOfferSchema.index({ businessId: 1, active: 1, validTill: 1 });

export const MarketingOffer = model<IMarketingOffer>('marketingOffers', marketingOfferSchema);

