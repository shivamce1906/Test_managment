import { z } from 'zod';
import { objectIdSchema } from './common.schema';

export const createPlanSchema = z.object({
  type: z.enum(['membership', 'package', 'wallet_offer', 'voucher']),
  name: z.string().min(1, 'Plan name is required'),
  pricePaise: z.number().int().nonnegative(),
  validityDays: z.number().int().positive('Validity days must be positive'),
  membership: z.object({
    serviceDiscountBps: z.number().int().nonnegative().default(0),
    productDiscountBps: z.number().int().nonnegative().default(0),
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
});

export const updatePlanSchema = z.object({
  name: z.string().min(1).optional(),
  active: z.boolean().optional(),
});

export const extendPlanSchema = z.object({
  days: z.number().int().positive('Extension days must be positive'),
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

