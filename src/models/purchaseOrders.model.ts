import { Schema, model, Document, Types } from 'mongoose';
import { tenantScopePlugin } from './plugins/tenantScope.plugin';
import { baseFieldsPlugin } from './plugins/baseFields.plugin';

export interface IPurchaseOrderItem {
  productId: Types.ObjectId;
  qtyPurchaseUnits: number;
  ratePaise: number;
  receivedPurchaseUnits: number;
}

export interface IPurchaseOrderReceiptItem {
  productId: Types.ObjectId;
  qty: number;
  batch?: string;
  expiry?: string;
}

export interface IPurchaseOrder extends Document {
  businessId: Types.ObjectId;
  branchId: Types.ObjectId;
  vendorId: Types.ObjectId;
  poNo: string;
  items: IPurchaseOrderItem[];
  totalPaise: number;
  status: 'draft' | 'pending_approval' | 'approved' | 'partly_received' | 'received' | 'rejected' | 'cancelled';
  approvals: {
    action: string;
    by: Types.ObjectId;
    at: Date;
    reason?: string;
  }[];
  receipts: {
    at: Date;
    by: Types.ObjectId;
    items: IPurchaseOrderReceiptItem[];
  }[];
  vendorBill?: {
    number: string;
    amountPaise: number;
    paymentStatus: 'unpaid' | 'partly_paid' | 'paid';
    paidPaise: number;
  };
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

const purchaseOrderSchema = new Schema<IPurchaseOrder>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'branches', required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: 'vendors', required: true },
    poNo: { type: String, required: true },
    items: [
      {
        productId: { type: Schema.Types.ObjectId, ref: 'products', required: true },
        qtyPurchaseUnits: { type: Number, required: true },
        ratePaise: { type: Number, required: true },
        receivedPurchaseUnits: { type: Number, default: 0, required: true },
      },
    ],
    totalPaise: { type: Number, required: true },
    status: {
      type: String,
      enum: ['draft', 'pending_approval', 'approved', 'partly_received', 'received', 'rejected', 'cancelled'],
      default: 'draft',
      required: true,
    },
    approvals: [
      {
        action: { type: String, required: true },
        by: { type: Schema.Types.ObjectId, ref: 'users', required: true },
        at: { type: Date, default: Date.now, required: true },
        reason: { type: String },
      },
    ],
    receipts: [
      {
        at: { type: Date, default: Date.now, required: true },
        by: { type: Schema.Types.ObjectId, ref: 'users', required: true },
        items: [
          {
            productId: { type: Schema.Types.ObjectId, ref: 'products', required: true },
            qty: { type: Number, required: true },
            batch: { type: String },
            expiry: { type: String },
          },
        ],
      },
    ],
    vendorBill: {
      number: { type: String },
      amountPaise: { type: Number },
      paymentStatus: { type: String, enum: ['unpaid', 'partly_paid', 'paid'], default: 'unpaid' },
      paidPaise: { type: Number, default: 0 },
    },
  },
  {
    collection: 'purchaseOrders',
  }
);

purchaseOrderSchema.plugin(baseFieldsPlugin);
purchaseOrderSchema.plugin(tenantScopePlugin);

purchaseOrderSchema.index({ businessId: 1, status: 1, createdAt: -1 });
purchaseOrderSchema.index({ businessId: 1, poNo: 1 }, { unique: true });

export const PurchaseOrder = model<IPurchaseOrder>('purchaseOrders', purchaseOrderSchema);
