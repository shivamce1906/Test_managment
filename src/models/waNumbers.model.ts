import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IWaNumber extends Document {
  businessId: Types.ObjectId;
  phone: string;
  aisensy: {
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
    aisensy: {
      apiKeyEnc: { type: String, required: true },
      projectId: { type: String, required: true },
      webhookSecretEnc: { type: String, required: true },
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
