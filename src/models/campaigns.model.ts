import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface ICampaign extends Document {
  businessId: Types.ObjectId;
  name: string;
  numberId: Types.ObjectId;
  templateId: Types.ObjectId;
  audience: {
    kind: 'segment' | 'upload' | 'selection';
    segment?: Record<string, any>;
    customerIds?: Types.ObjectId[];
    uploadKey?: string;
  };
  variableMap: Record<string, string>;
  scheduledAt?: Date;
  status: 'draft' | 'scheduled' | 'sending' | 'paused' | 'completed' | 'cancelled';
  stats: {
    total: number;
    excluded: number;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    costPaise: number;
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
    audience: {
      kind: { type: String, enum: ['segment', 'upload', 'selection'], required: true },
      segment: { type: Schema.Types.Mixed },
      customerIds: [{ type: Schema.Types.ObjectId, ref: 'customers' }],
      uploadKey: { type: String },
    },
    variableMap: { type: Schema.Types.Mixed, default: {} },
    scheduledAt: { type: Date },
    status: {
      type: String,
      enum: ['draft', 'scheduled', 'sending', 'paused', 'completed', 'cancelled'],
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
