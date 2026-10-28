import { Schema, model, Document, Types } from 'mongoose';

export interface IBusiness extends Document {
  name: string;
  logoUrl?: string;
  address: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    pincode: string;
  };
  gst: {
    enabled: boolean;
    gstin?: string;
    pan?: string;
    rateBps: number;
    sac: string;
    pricesInclusive: boolean;
  };
  fyStartMonth: number;
  discountLimits: {
    managerBps: number;
    branchBps: number;
    ownerAlertBps: number;
  };
  dayEndReportTime: string;
  loyalty: {
    enabled: boolean;
    earnPer100?: number;
    redeemValuePaise?: number;
    minRedeem?: number;
    expiryDays?: number;
  };
  payroll: {
    pf: { enabled: boolean; employeePct?: number; wageCeilingPaise?: number };
    esi: { enabled: boolean; employeePct?: number; wageCeilingPaise?: number };
    pt: { enabled: boolean; slabs?: { uptoPaise: number; amountPaise: number }[] };
  };
  automationGuards: {
    quietStart: string;
    quietEnd: string;
    maxMarketingPerDay: number;
  };
  ownerWhatsappPhone: string;
  defaultWaNumberId?: Types.ObjectId;
  headBranchId?: Types.ObjectId;
  status: 'active' | 'suspended';
  createdAt: Date;
  updatedAt: Date;
}

const businessSchema = new Schema<IBusiness>(
  {
    name: { type: String, required: true },
    logoUrl: { type: String },
    address: {
      line1: { type: String, required: true },
      line2: { type: String },
      city: { type: String, required: true },
      state: { type: String, required: true },
      pincode: { type: String, required: true },
    },
    gst: {
      enabled: { type: Boolean, default: false, required: true },
      gstin: { type: String },
      pan: { type: String },
      rateBps: { type: Number, default: 1800, required: true },
      sac: { type: String, default: '9983', required: true },
      pricesInclusive: { type: Boolean, default: false, required: true },
    },
    fyStartMonth: { type: Number, default: 4, required: true },
    discountLimits: {
      managerBps: { type: Number, default: 2000, required: true },
      branchBps: { type: Number, default: 1000, required: true },
      ownerAlertBps: { type: Number, default: 2500, required: true },
    },
    dayEndReportTime: { type: String, default: '23:00', required: true },
    loyalty: {
      enabled: { type: Boolean, default: false, required: true },
      earnPer100: { type: Number, default: 1 },
      redeemValuePaise: { type: Number, default: 100 },
      minRedeem: { type: Number, default: 100 },
      expiryDays: { type: Number, default: 365 },
    },
    payroll: {
      pf: { enabled: { type: Boolean, default: false }, employeePct: { type: Number, default: 12 }, wageCeilingPaise: { type: Number, default: 1500000 } },
      esi: { enabled: { type: Boolean, default: false }, employeePct: { type: Number, default: 0.75 }, wageCeilingPaise: { type: Number, default: 2100000 } },
      pt: { enabled: { type: Boolean, default: false }, slabs: { type: [{ uptoPaise: Number, amountPaise: Number }], default: [] } },
    },
    automationGuards: {
      quietStart: { type: String, default: '21:00', required: true },
      quietEnd: { type: String, default: '09:00', required: true },
      maxMarketingPerDay: { type: Number, default: 1, required: true },
    },
    ownerWhatsappPhone: { type: String, required: true },
    defaultWaNumberId: { type: Schema.Types.ObjectId, ref: 'waNumbers' },
    headBranchId: { type: Schema.Types.ObjectId, ref: 'branches' },
    status: { type: String, enum: ['active', 'suspended'], default: 'active', required: true },
  },
  {
    collection: 'businesses',
    timestamps: true,
  }
);

export const Business = model<IBusiness>('businesses', businessSchema);
