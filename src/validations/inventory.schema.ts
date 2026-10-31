import { z } from 'zod';
import { objectIdSchema } from './common.schema';

export const stockAdjustmentSchema = z.object({
  productId: objectIdSchema,
  pool: z.enum(['retail', 'consumable']),
  qty: z.number().int().refine((val) => val !== 0, 'Quantity delta must be non-zero'),
  reason: z.string().min(1, 'Reason is mandatory'),
  type: z.enum(['adjust', 'internal_use']).default('adjust'),
});
export const adjustStockSchema = stockAdjustmentSchema;


export const createPurchaseOrderSchema = z.object({
  branchId: objectIdSchema,
  vendorId: objectIdSchema,
  items: z.array(z.object({
    productId: objectIdSchema,
    qtyPurchaseUnits: z.number().int().positive('Quantity must be positive'),
    ratePaise: z.number().int().nonnegative('Rate must be non-negative'),
  })).min(1, 'At least one item is required'),
});

export const receivePurchaseOrderSchema = z.object({
  items: z.array(z.object({
    productId: objectIdSchema,
    qty: z.number().int().positive('Received quantity must be positive in purchase units'),
    pool: z.enum(['retail', 'consumable']).optional(), // only for products of type 'both'
    batch: z.string().optional(),
    expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })).min(1, 'At least one received item is required'),
});

// paymentStatus is derived from the amounts and may be left out
export const vendorBillSchema = z.object({
  number: z.string().trim().min(1, 'Vendor bill number is required'),
  amountPaise: z.number().int().positive(),
  paymentStatus: z.enum(['unpaid', 'partly_paid', 'paid']).optional(),
  paidPaise: z.number().int().nonnegative().default(0),
}).refine((b) => b.paidPaise <= b.amountPaise, { path: ['paidPaise'], message: 'Paid amount cannot be more than the bill amount' });
export const recordVendorBillSchema = vendorBillSchema;


export const createTransferSchema = z.object({
  fromBranchId: objectIdSchema,
  toBranchId: objectIdSchema,
  items: z.array(z.object({
    productId: objectIdSchema,
    pool: z.enum(['retail', 'consumable']),
    qty: z.number().int().positive(),
  })).min(1, 'At least one item required'),
}).refine((data) => data.fromBranchId !== data.toBranchId, {
  message: 'From and To branches must be different',
});

export const receiveTransferSchema = z.object({
  items: z.array(z.object({
    productId: objectIdSchema,
    receivedQty: z.number().int().nonnegative(),
    mismatchReason: z.string().trim().optional(),
  })).min(1),
});

export const decidePurchaseOrderSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().optional(),
}).refine((d) => d.decision === 'approve' || !!d.reason, { path: ['reason'], message: 'A reason is required to reject' });

export const stockQuerySchema = z.object({
  pool: z.enum(['retail', 'consumable']).optional(),
  productId: objectIdSchema.optional(),
  lowOnly: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

export const stockMovementsQuerySchema = z.object({
  productId: objectIdSchema.optional(),
  pool: z.enum(['retail', 'consumable']).optional(),
  type: z.enum(['purchase', 'sale', 'service_use', 'transfer_out', 'transfer_in', 'adjust', 'internal_use', 'cancel_reverse', 'audit', 'imported']).optional(),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

export const listPurchaseOrdersQuerySchema = z.object({
  branchId: objectIdSchema.optional(),
  vendorId: objectIdSchema.optional(),
  status: z.enum(['draft', 'pending_approval', 'approved', 'partly_received', 'received', 'rejected', 'cancelled']).optional(),
});

export const listTransfersQuerySchema = z.object({
  branchId: objectIdSchema.optional(),
  status: z.enum(['requested', 'approved', 'dispatched', 'received', 'rejected', 'cancelled']).optional(),
});

export const listProductsQuerySchema = z.object({
  type: z.enum(['retail', 'consumable', 'both']).optional(),
  active: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

export const createStockAuditSchema = z.object({
  pool: z.enum(['retail', 'consumable']),
});

export const updateStockAuditCountsSchema = z.object({
  lines: z.array(z.object({
    productId: objectIdSchema,
    countedQty: z.number().int().nonnegative(),
  })).min(1),
});
