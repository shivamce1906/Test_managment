import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IBranch extends Document {
  businessId: Types.ObjectId;
  name: string;
  code: string;
  invoicePrefix: string;
  address: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    pincode: string;
  };
  phone: string;
  hours: {
    day: number;
    open?: string;
    close?: string;
    closed: boolean;
  }[];
  holidays: {
    date: string;
    name: string;
  }[];
  stations?: number;
  waNumberId?: Types.ObjectId;
  googleReviewUrl?: string;
  pettyCashFloatPaise: number;
  status: 'active' | 'deactivation_requested' | 'deactivated';
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
  __v: number;
}

const branchSchema = new Schema<IBranch>(
  {
    name: { type: String, required: true },
    code: { type: String, required: true },
    invoicePrefix: { type: String, required: true },
    address: {
      line1: { type: String, required: true },
      line2: { type: String },
      city: { type: String, required: true },
      state: { type: String, required: true },
      pincode: { type: String, required: true },
    },
    phone: { type: String, required: true },
    hours: {
      type: [
        {
          day: { type: Number, min: 0, max: 6, required: true },
          open: { type: String },
          close: { type: String },
          closed: { type: Boolean, required: true, default: false },
        },
      ],
      default: [
        { day: 0, open: '10:00', close: '20:00', closed: false },
        { day: 1, open: '10:00', close: '20:00', closed: false },
        { day: 2, open: '10:00', close: '20:00', closed: false },
        { day: 3, open: '10:00', close: '20:00', closed: false },
        { day: 4, open: '10:00', close: '20:00', closed: false },
        { day: 5, open: '10:00', close: '20:00', closed: false },
        { day: 6, open: '10:00', close: '20:00', closed: false },
      ],
      required: true,
    },
    holidays: {
      type: [
        {
          date: { type: String, required: true },
          name: { type: String, required: true },
        },
      ],
      default: [],
    },
    stations: { type: Number, default: 4 },
    waNumberId: { type: Schema.Types.ObjectId, ref: 'waNumbers' },
    googleReviewUrl: { type: String },
    pettyCashFloatPaise: { type: Number, default: 0, required: true },
    status: {
      type: String,
      enum: ['active', 'deactivation_requested', 'deactivated'],
      default: 'active',
      required: true,
    },
  },
  {
    collection: 'branches',
  }
);

branchSchema.plugin(baseFieldsPlugin);
branchSchema.plugin(tenantScopePlugin);

branchSchema.index({ businessId: 1, code: 1 }, { unique: true });
branchSchema.index({ businessId: 1, invoicePrefix: 1 }, { unique: true });

export const Branch = model<IBranch>('branches', branchSchema);
