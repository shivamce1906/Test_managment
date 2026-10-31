import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface ICustomerPlanSession {
  serviceId: Types.ObjectId;
  total: number;
  used: number;
  perSessionValuePaise: number;
}

export interface ICustomerPlan extends Document {
  businessId: Types.ObjectId;
  customerId: Types.ObjectId;
  planId: Types.ObjectId;
  planSnap: Record<string, any>;
  soldBillId: Types.ObjectId;
  soldBranchId: Types.ObjectId;
  validFrom: string;
  validTill: string;
  sessions?: ICustomerPlanSession[];
  voucherCode?: string;
  status: 'active' | 'frozen' | 'expired' | 'used_up' | 'transferred' | 'cancelled';
  frozenAt?: Date;
  log: {
    action: 'sold' | 'extend' | 'freeze' | 'unfreeze' | 'transfer' | 'redeem' | 'reverse' | 'cancel';
    at: Date;
    by: Types.ObjectId;
    detail?: Record<string, any>;
  }[];
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const customerPlanSchema = new Schema<ICustomerPlan>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'customers', required: true },
    planId: { type: Schema.Types.ObjectId, ref: 'plans', required: true },
    planSnap: { type: Schema.Types.Mixed, required: true },
    soldBillId: { type: Schema.Types.ObjectId, ref: 'bills', required: true },
    soldBranchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    validFrom: { type: String, required: true },
    validTill: { type: String, required: true },
    sessions: [
      {
        serviceId: { type: Schema.Types.ObjectId, ref: 'services', required: true },
        total: { type: Number, required: true },
        used: { type: Number, default: 0, required: true },
        perSessionValuePaise: { type: Number, required: true },
      },
    ],
    voucherCode: { type: String },
    status: {
      type: String,
      enum: ['active', 'frozen', 'expired', 'used_up', 'transferred', 'cancelled'],
      default: 'active',
      required: true,
    },
    frozenAt: { type: Date },
    log: [
      {
        action: {
          type: String,
          enum: ['sold', 'extend', 'freeze', 'unfreeze', 'transfer', 'redeem', 'reverse', 'cancel'],
          required: true,
        },
        at: { type: Date, default: Date.now, required: true },
        by: { type: Schema.Types.ObjectId, ref: 'users', required: true },
        detail: { type: Schema.Types.Mixed },
      },
    ],
  },
  {
    collection: 'customerPlans',
  }
);

customerPlanSchema.plugin(baseFieldsPlugin);
customerPlanSchema.plugin(tenantScopePlugin);

customerPlanSchema.index({ businessId: 1, customerId: 1, status: 1 });
customerPlanSchema.index({ businessId: 1, validTill: 1, status: 1 });
// Unique voucher codes per business. Partial, not sparse: a compound sparse index still indexes
// every plan (businessId is always set) with voucherCode null, allowing only one non-voucher plan.
customerPlanSchema.index(
  { businessId: 1, voucherCode: 1 },
  { unique: true, partialFilterExpression: { voucherCode: { $type: 'string' } }, name: 'businessId_1_voucherCode_1_partial' }
);

export const CustomerPlan = model<ICustomerPlan>('customerPlans', customerPlanSchema);
