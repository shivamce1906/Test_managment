import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IDayClosureExpected {
  cashPaise: number;
  upiPaise: number;
  cardPaise: number;
}

export interface IDayClosureCounted {
  cashPaise: number;
  denominations: Record<string, number>;
  upiPaise: number;
  cardPaise: number;
}

export interface IDayClosureDiff {
  cashPaise: number;
  upiPaise: number;
  cardPaise: number;
}

export interface IDayClosure extends Document {
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  businessDate: string;
  expected: IDayClosureExpected;
  counted?: IDayClosureCounted;
  diff?: IDayClosureDiff;
  diffReason?: string;
  status: 'open' | 'submitted' | 'approved';
  submittedBy?: Types.ObjectId;
  approvedBy?: Types.ObjectId;
  approvedAt?: Date;
  reopenLog: {
    by: Types.ObjectId;
    at: Date;
    reason: string;
  }[];
  report?: {
    sentAt?: Date;
    pdfKey?: string;
    closedAtSend: boolean;
  };
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const dayClosureSchema = new Schema<IDayClosure>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    businessDate: { type: String, required: true },
    expected: {
      cashPaise: { type: Number, default: 0, required: true },
      upiPaise: { type: Number, default: 0, required: true },
      cardPaise: { type: Number, default: 0, required: true },
    },
    counted: {
      cashPaise: { type: Number },
      denominations: { type: Schema.Types.Mixed },
      upiPaise: { type: Number },
      cardPaise: { type: Number },
    },
    diff: {
      cashPaise: { type: Number },
      upiPaise: { type: Number },
      cardPaise: { type: Number },
    },
    diffReason: { type: String },
    status: { type: String, enum: ['open', 'submitted', 'approved'], default: 'open', required: true },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'users' },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'users' },
    approvedAt: { type: Date },
    reopenLog: [
      {
        by: { type: Schema.Types.ObjectId, ref: 'users', required: true },
        at: { type: Date, default: Date.now, required: true },
        reason: { type: String, required: true },
      },
    ],
    report: {
      sentAt: { type: Date },
      pdfKey: { type: String },
      closedAtSend: { type: Boolean },
    },
  },
  {
    collection: 'dayClosures',
  }
);

dayClosureSchema.plugin(baseFieldsPlugin);
dayClosureSchema.plugin(tenantScopePlugin);

dayClosureSchema.index({ businessId: 1, branchId: 1, businessDate: 1 }, { unique: true });

export const DayClosure = model<IDayClosure>('dayClosures', dayClosureSchema);
