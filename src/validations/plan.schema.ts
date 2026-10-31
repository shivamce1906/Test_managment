import { z } from 'zod';
import { objectIdSchema } from './common.schema';

export const createPlanSchema = z.object({
  type: z.enum(['membership', 'package', 'wallet_offer', 'voucher']),
  name: z.string().trim().min(1, 'Plan name is required'),
  pricePaise: z.number().int().nonnegative(),
  validityDays: z.number().int().positive('Validity days must be positive').max(3650),
  membership: z.object({
    serviceDiscountBps: z.number().int().min(0).max(10000).default(0),
    productDiscountBps: z.number().int().min(0).max(10000).default(0),
  }).optional(),
  package: z.object({
    items: z.array(z.object({
      serviceId: objectIdSchema,
      sessions: z.number().int().positive(),
    })).min(1),
  }).optional(),
  walletOffer: z.object({
    creditPaise: z.number().int().positive(),
  }).optional(),
  voucher: z.object({
    valuePaise: z.number().int().positive(),
  }).optional(),
  branchScope: z.array(objectIdSchema).default([]),
  active: z.boolean().default(true),
}).superRefine((p, ctx) => {
  // Each type needs its own block
  const need = { membership: 'membership', package: 'package', wallet_offer: 'walletOffer', voucher: 'voucher' } as const;
  const key = need[p.type];
  if (!(p as any)[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required for a ${p.type} plan` });
  if (p.type === 'wallet_offer' && p.walletOffer && p.walletOffer.creditPaise < p.pricePaise) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['walletOffer', 'creditPaise'], message: 'Credit must be at least the price' });
  }
});

// Price and contents cannot change; deactivate the plan and create a new one instead
export const updatePlanSchema = z.object({
  name: z.string().trim().min(1).optional(),
  active: z.boolean().optional(),
  validityDays: z.number().int().positive().max(3650).optional(),
  branchScope: z.array(objectIdSchema).optional(),
}).strict();

export const listPlansQuerySchema = z.object({
  type: z.enum(['membership', 'package', 'wallet_offer', 'voucher']).optional(),
  active: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

export const extendPlanSchema = z.object({
  days: z.number().int().positive('Extension days must be positive').max(3650),
});

export const freezePlanSchema = z.object({
  reason: z.string().min(1, 'Reason is required'),
});

export const transferPlanSchema = z.object({
  toCustomerId: objectIdSchema,
});

export const extendCustomerPlanSchema = extendPlanSchema;
export const freezeCustomerPlanSchema = freezePlanSchema;
export const transferCustomerPlanSchema = transferPlanSchema;

export const adjustWalletSchema = z.object({
  amountPaise: z.number().int().refine((val) => val !== 0, 'Amount must be non-zero'),
  reason: z.string().min(1, 'Reason is mandatory for wallet adjustment'),
});

