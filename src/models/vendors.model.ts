import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IVendor extends Document {
  businessId: Types.ObjectId;
  name: string;
  contact?: string;
  phone?: string;
  gstin?: string;
  address?: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    pincode: string;
  };
  terms?: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
  __v: number;
}

const vendorSchema = new Schema<IVendor>(
  {
    name: { type: String, required: true },
    contact: { type: String },
    phone: { type: String },
    gstin: { type: String },
    address: {
      line1: { type: String },
      line2: { type: String },
      city: { type: String },
      state: { type: String },
      pincode: { type: String },
    },
    terms: { type: String },
  },
  {
    collection: 'vendors',
  }
);

vendorSchema.plugin(baseFieldsPlugin);
vendorSchema.plugin(tenantScopePlugin);

vendorSchema.index({ businessId: 1, name: 1 });

export const Vendor = model<IVendor>('vendors', vendorSchema);
