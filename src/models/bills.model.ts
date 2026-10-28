import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IBillLine {
  _id?: Types.ObjectId;
  kind: 'service' | 'product' | 'membership' | 'package' | 'wallet_topup' | 'voucher';
  refId: Types.ObjectId;
  name: string;
  hsnSac?: string;
  qty: number;
  unitPricePaise: number;
  lineDiscount?: {
    type: 'amount' | 'pct';
    value: number;
  };
  discountPaise: number;
  taxablePaise: number;
  gstBps: number;
  cgstPaise: number;
  sgstPaise: number;
  totalPaise: number;
  staff: {
    staffId: Types.ObjectId;
    name: string;
    splitBps: number;
    commissionPaise: number;
  }[];
  consumablesUsed?: {
    productId: Types.ObjectId;
    qty: number;
    costPaise: number;
  }[];
}

export interface IBillRedemption {
  kind: 'package' | 'membership' | 'loyalty' | 'voucher';
  refId: Types.ObjectId;
  lineId?: Types.ObjectId;
  points?: number;
  amountPaise: number;
}

export interface IBillPayment {
  mode: 'cash' | 'upi' | 'card' | 'wallet';
  amountPaise: number;
  businessDate: string;
  tenderedPaise?: number;
  ref?: string;
  at: Date;
}

export interface IBillTip {
  staffId: Types.ObjectId;
  staffName: string;
  amountPaise: number;
  payout: 'cash_today' | 'payroll';
}

export interface IBillTotals {
  grossPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  roundOffPaise: number;
  totalPaise: number;
  paidPaise: number;
  duePaise: number;
}

export interface IBillRefund {
  amountPaise: number;
  mode: string;
  reason: string;
  by: Types.ObjectId;
  at: Date;
  businessDate: string;
}

export interface IBill extends Document {
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  invoiceNo: string;
  fy: string;
  businessDate: string;
  customerId: Types.ObjectId;
  customerSnap: {
    name: string;
    phone: string;
    gstin?: string;
  };
  billedByStaffId?: Types.ObjectId;
  billedByName: string;
  appointmentId?: Types.ObjectId;
  gstApplied: boolean;
  pricesInclusive: boolean;
  lines: IBillLine[];
  billDiscount?: {
    type: 'amount' | 'pct';
    value: number;
  };
  redemptions: IBillRedemption[];
  totals: IBillTotals;
  payments: IBillPayment[];
  tips: IBillTip[];
  status: 'awaiting_approval' | 'rejected' | 'paid' | 'partly_paid' | 'cancelled' | 'refunded' | 'partly_refunded';
  approval?: {
    reasons: ('discount_over_limit' | 'partly_paid')[];
    requestedAt: Date;
    decidedBy?: Types.ObjectId;
    decidedAt?: Date;
    rejectReason?: string;
  };
  version: number;
  cancel?: {
    by: Types.ObjectId;
    at: Date;
    reason: string;
  };
  refunds: IBillRefund[];
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const billSchema = new Schema<IBill>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    invoiceNo: { type: String, required: true },
    fy: { type: String, required: true },
    businessDate: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'customers', required: true },
    customerSnap: {
      name: { type: String, required: true },
      phone: { type: String, required: true },
      gstin: { type: String },
    },
    billedByStaffId: { type: Schema.Types.ObjectId, ref: 'staff' },
    billedByName: { type: String, required: true },
    appointmentId: { type: Schema.Types.ObjectId, ref: 'appointments' },
    gstApplied: { type: Boolean, required: true },
    pricesInclusive: { type: Boolean, required: true },
    lines: [
      {
        kind: {
          type: String,
          enum: ['service', 'product', 'membership', 'package', 'wallet_topup', 'voucher'],
          required: true,
        },
        refId: { type: Schema.Types.ObjectId, required: true },
        name: { type: String, required: true },
        hsnSac: { type: String },
        qty: { type: Number, required: true },
        unitPricePaise: { type: Number, required: true },
        lineDiscount: {
          type: { type: String, enum: ['amount', 'pct'] },
          value: { type: Number },
        },
        discountPaise: { type: Number, default: 0, required: true },
        taxablePaise: { type: Number, required: true },
        gstBps: { type: Number, default: 0, required: true },
        cgstPaise: { type: Number, default: 0, required: true },
        sgstPaise: { type: Number, default: 0, required: true },
        totalPaise: { type: Number, required: true },
        staff: [
          {
            staffId: { type: Schema.Types.ObjectId, ref: 'staff', required: true },
            name: { type: String, required: true },
            splitBps: { type: Number, required: true },
            commissionPaise: { type: Number, default: 0, required: true },
          },
        ],
        consumablesUsed: [
          {
            productId: { type: Schema.Types.ObjectId, ref: 'products', required: true },
            qty: { type: Number, required: true },
            costPaise: { type: Number, required: true },
          },
        ],
      },
    ],
    billDiscount: {
      type: { type: String, enum: ['amount', 'pct'] },
      value: { type: Number },
    },
    redemptions: [
      {
        kind: { type: String, enum: ['package', 'membership', 'loyalty', 'voucher'], required: true },
        refId: { type: Schema.Types.ObjectId, required: true },
        lineId: { type: Schema.Types.ObjectId },
        points: { type: Number },
        amountPaise: { type: Number, required: true },
      },
    ],
    totals: {
      grossPaise: { type: Number, required: true },
      discountPaise: { type: Number, default: 0, required: true },
      taxablePaise: { type: Number, required: true },
      cgstPaise: { type: Number, default: 0, required: true },
      sgstPaise: { type: Number, default: 0, required: true },
      roundOffPaise: { type: Number, default: 0, required: true },
      totalPaise: { type: Number, required: true },
      paidPaise: { type: Number, default: 0, required: true },
      duePaise: { type: Number, default: 0, required: true },
    },
    payments: [
      {
        mode: { type: String, enum: ['cash', 'upi', 'card', 'wallet'], required: true },
        amountPaise: { type: Number, required: true },
        businessDate: { type: String, required: true },
        tenderedPaise: { type: Number },
        ref: { type: String },
        at: { type: Date, default: Date.now, required: true },
      },
    ],
    tips: [
      {
        staffId: { type: Schema.Types.ObjectId, ref: 'staff', required: true },
        staffName: { type: String, required: true },
        amountPaise: { type: Number, required: true },
        payout: { type: String, enum: ['cash_today', 'payroll'], required: true },
      },
    ],
    status: {
      type: String,
      enum: ['awaiting_approval', 'rejected', 'paid', 'partly_paid', 'cancelled', 'refunded', 'partly_refunded'],
      default: 'paid',
      required: true,
    },
    approval: {
      reasons: [{ type: String, enum: ['discount_over_limit', 'partly_paid'] }],
      requestedAt: { type: Date },
      decidedBy: { type: Schema.Types.ObjectId, ref: 'users' },
      decidedAt: { type: Date },
      rejectReason: { type: String },
    },
    version: { type: Number, default: 1, required: true },
    cancel: {
      by: { type: Schema.Types.ObjectId, ref: 'users' },
      at: { type: Date },
      reason: { type: String },
    },
    refunds: [
      {
        amountPaise: { type: Number, required: true },
        mode: { type: String, required: true },
        reason: { type: String, required: true },
        by: { type: Schema.Types.ObjectId, ref: 'users', required: true },
        at: { type: Date, default: Date.now, required: true },
        businessDate: { type: String, required: true },
      },
    ],
    idempotencyKey: { type: String, required: true },
  },
  {
    collection: 'bills',
    timestamps: true,
  }
);

billSchema.plugin(tenantScopePlugin);

billSchema.index({ businessId: 1, invoiceNo: 1 }, { unique: true });
billSchema.index({ businessId: 1, idempotencyKey: 1 }, { unique: true });
billSchema.index({ businessId: 1, branchId: 1, businessDate: -1 });
billSchema.index({ businessId: 1, customerId: 1, businessDate: -1 });
billSchema.index({ businessId: 1, status: 1, branchId: 1 });
billSchema.index({ businessId: 1, branchId: 1, 'payments.businessDate': 1 });
billSchema.index({ businessId: 1, branchId: 1, 'refunds.businessDate': 1 }, { sparse: true });

export const Bill = model<IBill>('bills', billSchema);
