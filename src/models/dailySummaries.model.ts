import { Schema, model, Document, Types } from 'mongoose';

export interface IDailySummarySales {
  grossPaise: number;
  discountPaise: number;
  netPaise: number;
  taxPaise: number;
  servicesPaise: number;
  productsPaise: number;
  plansPaise: number;
}

export interface IDailySummaryCounts {
  bills: number;
  cancelled: number;
  customers: number;
  newCustomers: number;
  appointments: number;
  noShows: number;
}

export interface IDailySummary extends Document<string> {
  _id: string; // `${branchId}:${businessDate}`
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  businessDate: string;
  sales: IDailySummarySales;
  collections: {
    cash: number;
    upi: number;
    card: number;
    wallet: number;
  };
  refundsPaise: number;
  tipsPaise: number;
  counts: IDailySummaryCounts;
  byService: Record<string, { count: number; netPaise: number }>;
  byStaff: Record<string, { netPaise: number; commissionPaise: number }>;
  byBilledBy: Record<string, { bills: number; netPaise: number }>;
  updatedAt: Date;
}

const dailySummarySchema = new Schema<IDailySummary>(
  {
    _id: { type: String, required: true },
    businessId: { type: Schema.Types.ObjectId, ref: 'businesses', required: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    businessDate: { type: String, required: true },
    sales: {
      grossPaise: { type: Number, default: 0, required: true },
      discountPaise: { type: Number, default: 0, required: true },
      netPaise: { type: Number, default: 0, required: true },
      taxPaise: { type: Number, default: 0, required: true },
      servicesPaise: { type: Number, default: 0, required: true },
      productsPaise: { type: Number, default: 0, required: true },
      plansPaise: { type: Number, default: 0, required: true },
    },
    collections: {
      cash: { type: Number, default: 0, required: true },
      upi: { type: Number, default: 0, required: true },
      card: { type: Number, default: 0, required: true },
      wallet: { type: Number, default: 0, required: true },
    },
    refundsPaise: { type: Number, default: 0, required: true },
    tipsPaise: { type: Number, default: 0, required: true },
    counts: {
      bills: { type: Number, default: 0, required: true },
      cancelled: { type: Number, default: 0, required: true },
      customers: { type: Number, default: 0, required: true },
      newCustomers: { type: Number, default: 0, required: true },
      appointments: { type: Number, default: 0, required: true },
      noShows: { type: Number, default: 0, required: true },
    },
    byService: { type: Schema.Types.Mixed, default: {} },
    byStaff: { type: Schema.Types.Mixed, default: {} },
    byBilledBy: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: 'dailySummaries',
    _id: false,
    timestamps: { createdAt: false, updatedAt: true },
  }
);

dailySummarySchema.index({ businessId: 1, businessDate: 1 });
dailySummarySchema.index({ businessId: 1, branchId: 1, businessDate: 1 });

export const DailySummary = model<IDailySummary>('dailySummaries', dailySummarySchema);
