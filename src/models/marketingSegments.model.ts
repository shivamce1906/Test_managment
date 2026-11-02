import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface ISegmentCriteria {
  customerType?: 'all' | 'new' | 'regular';
  inactivityDays?: 30 | 60 | 90 | number;
  spendTier?: {
    type: 'top_percentile' | 'min_spend';
    value: number; // e.g., 10 for top 10%, or 1500000 for ₹15,000 (in paise)
  };
  serviceIds?: Types.ObjectId[];
  categoryIds?: Types.ObjectId[];
  serviceWithinDays?: number;
  membershipStatus?: 'active_any' | 'plan_specific' | 'non_member';
  planIds?: Types.ObjectId[];
  gender?: 'male' | 'female' | 'other';
}

export interface IMarketingSegment extends Document {
  businessId: Types.ObjectId;
  name: string;
  description?: string;
  type: 'system_predefined' | 'custom_rule';
  criteria: ISegmentCriteria;
  cachedCount: number;
  lastCalculatedAt?: Date;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const marketingSegmentSchema = new Schema<IMarketingSegment>(
  {
    name: { type: String, required: true },
    description: { type: String },
    type: {
      type: String,
      enum: ['system_predefined', 'custom_rule'],
      default: 'custom_rule',
      required: true,
    },
    criteria: {
      customerType: { type: String, enum: ['all', 'new', 'regular'] },
      inactivityDays: { type: Number },
      spendTier: {
        type: { type: String, enum: ['top_percentile', 'min_spend'] },
        value: { type: Number },
      },
      serviceIds: [{ type: Schema.Types.ObjectId, ref: 'services' }],
      categoryIds: [{ type: Schema.Types.ObjectId, ref: 'categories' }],
      serviceWithinDays: { type: Number },
      membershipStatus: { type: String, enum: ['active_any', 'plan_specific', 'non_member'] },
      planIds: [{ type: Schema.Types.ObjectId, ref: 'plans' }],
      gender: { type: String, enum: ['male', 'female', 'other'] },
    },
    cachedCount: { type: Number, default: 0 },
    lastCalculatedAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: 'users' },
  },
  {
    collection: 'marketingSegments',
  }
);

marketingSegmentSchema.plugin(baseFieldsPlugin);
marketingSegmentSchema.plugin(tenantScopePlugin);

marketingSegmentSchema.index({ businessId: 1, type: 1 });
marketingSegmentSchema.index({ businessId: 1, name: 1 });

export const MarketingSegment = model<IMarketingSegment>('marketingSegments', marketingSegmentSchema);

