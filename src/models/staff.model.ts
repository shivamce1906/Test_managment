import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IStaff extends Document {
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  name: string;
  phone: string;
  designation: 'stylist' | 'senior_stylist' | 'beautician' | 'receptionist' | 'manager' | 'helper' | 'other';
  joiningDate: string;
  exitDate?: string;
  exitReason?: string;
  serviceIds: Types.ObjectId[];
  salary: {
    type: 'monthly' | 'none';
    amountPaise: number;
  };
  commission?: {
    service?: {
      type: 'pct' | 'fixed' | 'slab';
      value?: number;
      slabs?: { uptoPaise: number; bps: number }[];
    };
    productBps?: number;
    overtimePerHourPaise?: number;
  };
  statutory: {
    pf: boolean;
    esi: boolean;
    pt: boolean;
  };
  bankRef?: {
    bank: string;
    last4: string;
  };
  documents: {
    kind: string;
    s3Key: string;
  }[];
  emergencyContact?: {
    name: string;
    phone: string;
  };
  status: 'active' | 'exited';
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
  __v: number;
}

const staffSchema = new Schema<IStaff>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    name: { type: String, required: true },
    phone: { type: String, required: true },
    designation: {
      type: String,
      enum: ['stylist', 'senior_stylist', 'beautician', 'receptionist', 'manager', 'helper', 'other'],
      required: true,
    },
    joiningDate: { type: String, required: true },
    exitDate: { type: String },
    exitReason: { type: String },
    serviceIds: [{ type: Schema.Types.ObjectId, ref: 'services' }],
    salary: {
      type: { type: String, enum: ['monthly', 'none'], default: 'monthly', required: true },
      amountPaise: { type: Number, default: 0, required: true },
    },
    commission: {
      service: {
        type: { type: String, enum: ['pct', 'fixed', 'slab'] },
        value: { type: Number },
        slabs: [{ uptoPaise: Number, bps: Number }],
      },
      productBps: { type: Number },
      overtimePerHourPaise: { type: Number },
    },
    statutory: {
      pf: { type: Boolean, default: false, required: true },
      esi: { type: Boolean, default: false, required: true },
      pt: { type: Boolean, default: false, required: true },
    },
    bankRef: {
      bank: { type: String },
      last4: { type: String },
    },
    documents: [
      {
        kind: { type: String, required: true },
        s3Key: { type: String, required: true },
      },
    ],
    emergencyContact: {
      name: { type: String },
      phone: { type: String },
    },
    status: { type: String, enum: ['active', 'exited'], default: 'active', required: true },
  },
  {
    collection: 'staff',
  }
);

staffSchema.plugin(baseFieldsPlugin);
staffSchema.plugin(tenantScopePlugin);

staffSchema.index({ businessId: 1, branchId: 1, status: 1 });
staffSchema.index({ businessId: 1, phone: 1 });

export const Staff = model<IStaff>('staff', staffSchema);
