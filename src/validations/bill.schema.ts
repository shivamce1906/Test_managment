import { z } from 'zod';
import { objectIdSchema } from './common.schema';

export const billLineInputSchema = z.object({
  kind: z.enum(['service', 'product', 'membership', 'package', 'wallet_topup', 'voucher']),
  refId: objectIdSchema,
  qty: z.number().int().positive().default(1),
  lineDiscount: z.object({
    type: z.enum(['amount', 'pct']),
    value: z.number().int().nonnegative(), // paise if amount, bps if pct
  }).optional(),
  staff: z.array(z.object({
    staffId: objectIdSchema,
    splitBps: z.number().int().positive(), // sums to 10000 for service
  })).optional(),
});

export const billDiscountInputSchema = z.object({
  type: z.enum(['amount', 'pct']),
  value: z.number().int().nonnegative(), // paise if amount, bps if pct
});

export const redemptionInputSchema = z.object({
  kind: z.enum(['package', 'membership', 'loyalty', 'voucher']),
  refId: objectIdSchema, // customerPlanId, or for loyalty: customerId, or voucher customerPlanId
  lineId: z.string().optional(),
  points: z.number().int().positive().optional(),
  amountPaise: z.number().int().nonnegative().optional(),
});

export const tipInputSchema = z.object({
  staffId: objectIdSchema,
  amountPaise: z.number().int().positive(),
  payout: z.enum(['cash_today', 'payroll']),
});

export const paymentInputSchema = z.object({
  mode: z.enum(['cash', 'upi', 'card', 'wallet']),
  amountPaise: z.number().int().positive(),
  ref: z.string().optional(),
  tenderedPaise: z.number().int().nonnegative().optional(), // For cash change calculation
});

export const collectDueInputSchema = z.object({
  dueId: objectIdSchema,
  amountPaise: z.number().int().positive(),
});

export const createBillSchema = z.object({
  customerId: objectIdSchema,
  billedByStaffId: objectIdSchema.optional(), // Required if branch role, validated in service
  appointmentId: objectIdSchema.optional(),
  lines: z.array(billLineInputSchema).min(1, 'At least one line is required'),
  billDiscount: billDiscountInputSchema.optional(),
  redemptions: z.array(redemptionInputSchema).default([]),
  tips: z.array(tipInputSchema).default([]),
  payments: z.array(paymentInputSchema).default([]),
  collectDues: z.array(collectDueInputSchema).optional(),
});

export const editBillSchema = createBillSchema.extend({
  reason: z.string().min(1, 'Edit reason is mandatory'),
  __v: z.number().int(),
  payments: z.array(paymentInputSchema).optional(),
});

export const cancelBillSchema = z.object({
  reason: z.string().min(1, 'Cancellation reason is mandatory'),
});

export const rejectBillSchema = z.object({
  reason: z.string().min(1, 'Rejection reason is mandatory'),
});

export const refundBillSchema = z.object({
  amountPaise: z.number().int().positive('Refund amount must be positive'),
  mode: z.enum(['cash', 'upi', 'card']),
  reason: z.string().min(1, 'Refund reason is mandatory'),
});

export const createDueReceiptSchema = z.object({
  customerId: objectIdSchema,
  payments: z.array(paymentInputSchema).min(1, 'At least one payment is required'),
});
export const collectDueReceiptSchema = createDueReceiptSchema;

