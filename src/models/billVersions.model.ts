import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IBillVersion extends Document {
  businessId: Types.ObjectId;
  billId: Types.ObjectId;
  version: number;
  snapshot: Record<string, any>;
  editedBy: Types.ObjectId;
  reason: string;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const billVersionSchema = new Schema<IBillVersion>(
  {
    billId: { type: Schema.Types.ObjectId, ref: 'bills', required: true },
    version: { type: Number, required: true },
    snapshot: { type: Schema.Types.Mixed, required: true },
    editedBy: { type: Schema.Types.ObjectId, ref: 'users', required: true },
    reason: { type: String, required: true },
  },
  {
    collection: 'billVersions',
  }
);

billVersionSchema.plugin(baseFieldsPlugin);
billVersionSchema.plugin(tenantScopePlugin);

billVersionSchema.index({ businessId: 1, billId: 1, version: 1 }, { unique: true });

export const BillVersion = model<IBillVersion>('billVersions', billVersionSchema);
