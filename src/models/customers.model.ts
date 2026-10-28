import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface ICustomer extends Document {
  businessId: Types.ObjectId;
  name: string;
  phone: string;
  altPhones: string[];
  email?: string;
  gender?: 'male' | 'female' | 'other';
  dob?: string;
  anniversary?: string;
  address?: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    pincode: string;
  };
  source: 'walk_in' | 'phone' | 'whatsapp' | 'referral';
  referredBy?: Types.ObjectId;
  tags: string[];
  waOptIn: boolean;
  doNotMessage: boolean;
  notes?: string;
  serviceNotes: {
    date: string;
    staffId?: Types.ObjectId;
    text: string;
    colourFormula?: string;
  }[];
  stats: {
    firstVisit?: string;
    lastVisit?: string;
    visits: number;
    spendPaise: number;
    noShows: number;
    favServiceId?: Types.ObjectId;
    favStaffId?: Types.ObjectId;
  };
  walletBalancePaise: number;
  loyaltyPoints: number;
  duePaise: number;
  mergedInto?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
  __v: number;
}

const customerSchema = new Schema<ICustomer>(
  {
    name: { type: String, required: true },
    phone: { type: String, required: true },
    altPhones: [{ type: String }],
    email: { type: String },
    gender: { type: String, enum: ['male', 'female', 'other'] },
    dob: { type: String },
    anniversary: { type: String },
    address: {
      line1: { type: String },
      line2: { type: String },
      city: { type: String },
      state: { type: String },
      pincode: { type: String },
    },
    source: { type: String, enum: ['walk_in', 'phone', 'whatsapp', 'referral'], default: 'walk_in', required: true },
    referredBy: { type: Schema.Types.ObjectId, ref: 'customers' },
    tags: [{ type: String }],
    waOptIn: { type: Boolean, default: true, required: true },
    doNotMessage: { type: Boolean, default: false, required: true },
    notes: { type: String },
    serviceNotes: [
      {
        date: { type: String, required: true },
        staffId: { type: Schema.Types.ObjectId, ref: 'staff' },
        text: { type: String, required: true },
        colourFormula: { type: String },
      },
    ],
    stats: {
      firstVisit: { type: String },
      lastVisit: { type: String },
      visits: { type: Number, default: 0, required: true },
      spendPaise: { type: Number, default: 0, required: true },
      noShows: { type: Number, default: 0, required: true },
      favServiceId: { type: Schema.Types.ObjectId, ref: 'services' },
      favStaffId: { type: Schema.Types.ObjectId, ref: 'staff' },
    },
    walletBalancePaise: { type: Number, default: 0, required: true },
    loyaltyPoints: { type: Number, default: 0, required: true },
    duePaise: { type: Number, default: 0, required: true },
    mergedInto: { type: Schema.Types.ObjectId, ref: 'customers' },
  },
  {
    collection: 'customers',
  }
);

customerSchema.plugin(baseFieldsPlugin);
customerSchema.plugin(tenantScopePlugin);

customerSchema.index({ businessId: 1, phone: 1 }, { unique: true });
customerSchema.index({ businessId: 1, altPhones: 1 });
customerSchema.index({ businessId: 1, 'stats.lastVisit': 1 });
customerSchema.index({ businessId: 1, dob: 1 });
customerSchema.index({ businessId: 1, name: 'text' });

export const Customer = model<ICustomer>('customers', customerSchema);
