import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface ICampaign extends Document {
  businessId: Types.ObjectId;
  name: string;
  numberId: Types.ObjectId;
  templateId: Types.ObjectId;
  offerId?: Types.ObjectId;
  audience: {
    kind: 'segment' | 'upload' | 'selection';
    segmentId?: Types.ObjectId;
    segment?: Record<string, any>;
    segmentCriteria?: Record<string, any>;
    customerIds?: Types.ObjectId[];
    /** Segment audiences: customers the owner unticked; never messaged. */
    excludeCustomerIds?: Types.ObjectId[];
    uploadKey?: string;
  };
  variableMap: Record<string, string>;
  scheduledAt?: Date;
  /** Set when the campaign worker has queued every message; only then can the campaign be closed. */
  queuedAt?: Date;
  status: 'draft' | 'scheduled' | 'sending' | 'paused' | 'completed' | 'cancelled' | 'failed';
  stats: {
    total: number;
    excluded: number;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    costPaise: number;
    conversions?: {
      billsCount: number;
      revenuePaise: number;
      discountGivenPaise: number;
    };
  };
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const campaignSchema = new Schema<ICampaign>(
  {
    name: { type: String, required: true },
    numberId: { type: Schema.Types.ObjectId, ref: 'waNumbers', required: true },
    templateId: { type: Schema.Types.ObjectId, ref: 'waTemplates', required: true },
    offerId: { type: Schema.Types.ObjectId, ref: 'marketingOffers' },
    audience: {
      kind: { type: String, enum: ['segment', 'upload', 'selection'], required: true },
      segmentId: { type: Schema.Types.ObjectId, ref: 'marketingSegments' },
      segment: { type: Schema.Types.Mixed },
      segmentCriteria: { type: Schema.Types.Mixed },
      customerIds: [{ type: Schema.Types.ObjectId, ref: 'customers' }],
      excludeCustomerIds: [{ type: Schema.Types.ObjectId, ref: 'customers' }],
      uploadKey: { type: String },
    },
    variableMap: { type: Schema.Types.Mixed, default: {} },
    scheduledAt: { type: Date },
    queuedAt: { type: Date },
    status: {
      type: String,
      enum: ['draft', 'scheduled', 'sending', 'paused', 'completed', 'cancelled', 'failed'],
      default: 'draft',
      required: true,
    },
    stats: {
      total: { type: Number, default: 0, required: true },
      excluded: { type: Number, default: 0, required: true },
      sent: { type: Number, default: 0, required: true },
      delivered: { type: Number, default: 0, required: true },
      read: { type: Number, default: 0, required: true },
      failed: { type: Number, default: 0, required: true },
      costPaise: { type: Number, default: 0, required: true },
      conversions: {
        billsCount: { type: Number, default: 0 },
        revenuePaise: { type: Number, default: 0 },
        discountGivenPaise: { type: Number, default: 0 },
      },
    },
  },
  {
    collection: 'campaigns',
  }
);

campaignSchema.plugin(baseFieldsPlugin);
campaignSchema.plugin(tenantScopePlugin);

campaignSchema.index({ businessId: 1, status: 1 });

export const Campaign = model<ICampaign>('campaigns', campaignSchema);
