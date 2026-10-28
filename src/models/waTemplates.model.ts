import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IWaTemplate extends Document {
  businessId: Types.ObjectId;
  numberId: Types.ObjectId;
  name: string;
  language: string;
  category: 'marketing' | 'utility' | 'authentication';
  body: string;
  variables: string[];
  status: 'approved' | 'pending' | 'rejected';
  syncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const waTemplateSchema = new Schema<IWaTemplate>(
  {
    numberId: { type: Schema.Types.ObjectId, ref: 'waNumbers', required: true },
    name: { type: String, required: true },
    language: { type: String, default: 'en', required: true },
    category: { type: String, enum: ['marketing', 'utility', 'authentication'], required: true },
    body: { type: String, required: true },
    variables: [{ type: String }],
    status: { type: String, enum: ['approved', 'pending', 'rejected'], default: 'pending', required: true },
    syncedAt: { type: Date, default: Date.now, required: true },
  },
  {
    collection: 'waTemplates',
  }
);

waTemplateSchema.plugin(baseFieldsPlugin);
waTemplateSchema.plugin(tenantScopePlugin);

waTemplateSchema.index({ businessId: 1, numberId: 1, name: 1 }, { unique: true });

export const WaTemplate = model<IWaTemplate>('waTemplates', waTemplateSchema);
