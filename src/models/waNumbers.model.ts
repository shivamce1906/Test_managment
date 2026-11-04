import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IWaNumber extends Document {
  businessId: Types.ObjectId;
  phone: string;
  provider: 'instant_broadcast' | 'aisensy';
  instantBroadcast?: {
    uid: string;
    userTokenEnc: string;
    apiKeyEnc?: string;
    webhookSecretEnc?: string;
  };
  aisensy?: {
    apiKeyEnc: string;
    projectId: string;
    webhookSecretEnc: string;
  };
  branchIds: Types.ObjectId[];
  status: 'active' | 'error';
  lastCheckAt?: Date;
  lowBalance: boolean;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const waNumberSchema = new Schema<IWaNumber>(
  {
    phone: { type: String, required: true },
    provider: { type: String, enum: ['instant_broadcast', 'aisensy'], default: 'instant_broadcast', required: true },
    instantBroadcast: {
      uid: { type: String },
      userTokenEnc: { type: String },
      apiKeyEnc: { type: String },
      webhookSecretEnc: { type: String },
    },
    aisensy: {
      apiKeyEnc: { type: String },
      projectId: { type: String },
      webhookSecretEnc: { type: String },
    },
    branchIds: [{ type: Schema.Types.ObjectId, ref: 'branches' }],
    status: { type: String, enum: ['active', 'error'], default: 'active', required: true },
    lastCheckAt: { type: Date },
    lowBalance: { type: Boolean, default: false, required: true },
  },
  {
    collection: 'waNumbers',
  }
);

waNumberSchema.plugin(baseFieldsPlugin);
waNumberSchema.plugin(tenantScopePlugin);

waNumberSchema.index({ businessId: 1, phone: 1 });

export const WaNumber = model<IWaNumber>('waNumbers', waNumberSchema);
