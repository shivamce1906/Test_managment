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
    batch: z.string().optional(),
    expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })).min(1, 'At least one received item is required'),
});

export const vendorBillSchema = z
  .object({
    number: z.string().min(1, 'Vendor bill number is required'),
    amountPaise: z.number().int().positive(),
    paymentStatus: z.enum(['unpaid', 'partly_paid', 'paid']).default('unpaid'),
    paidPaise: z.number().int().nonnegative().default(0),
  })
  .refine((data) => data.paidPaise <= data.amountPaise, {
    message: 'Paid amount cannot exceed bill amount',
    path: ['paidPaise'],
  });
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
    mismatchReason: z.string().optional(),
  })).min(1),
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
