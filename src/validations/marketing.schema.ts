import { z } from 'zod';
import { objectIdSchema } from './common.schema';

export const segmentCriteriaSchema = z.object({
  customerType: z.enum(['all', 'new', 'regular']).optional(),
  inactivityDays: z.number().int().min(1).optional(),
  spendTier: z
    .object({
      type: z.enum(['top_percentile', 'min_spend']),
      value: z.number().positive(),
    })
    .optional(),
  serviceIds: z.array(objectIdSchema).optional(),
  categoryIds: z.array(objectIdSchema).optional(),
  serviceWithinDays: z.number().int().positive().optional(),
  membershipStatus: z.enum(['active_any', 'plan_specific', 'non_member']).optional(),
  planIds: z.array(objectIdSchema).optional(),
  gender: z.enum(['male', 'female', 'other']).optional(),
});

export const createSegmentSchema = z.object({
  name: z.string().min(1, 'Segment name is required'),
  description: z.string().optional(),
  type: z.enum(['system_predefined', 'custom_rule']).default('custom_rule'),
  criteria: segmentCriteriaSchema,
});

export const updateSegmentSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  criteria: segmentCriteriaSchema.optional(),
});

export const previewSegmentSchema = z.object({
  criteria: segmentCriteriaSchema,
});

export const createOfferSchema = z.object({
  code: z
    .string()
    .min(3, 'Offer code must be at least 3 characters')
    .max(20, 'Offer code max 20 characters')
    .regex(/^[A-Za-z0-9_-]+$/, 'Offer code must be alphanumeric'),
  title: z.string().min(1, 'Title is required'),
  description: z.string().optional(),
  offerType: z.enum(['festival', 'special_discount', 'segment_exclusive', 'general']).default('festival'),
  discountType: z.enum(['percentage', 'flat']),
  discountValue: z.number().positive('Discount value must be positive'),
  maxDiscountPaise: z.number().int().positive().optional(),
  minBillAmountPaise: z.number().int().min(0).default(0),
  applicableTo: z
    .object({
      all: z.boolean().default(true),
      serviceIds: z.array(objectIdSchema).default([]),
      categoryIds: z.array(objectIdSchema).default([]),
      productIds: z.array(objectIdSchema).default([]),
    })
    .default({ all: true, serviceIds: [], categoryIds: [], productIds: [] }),
  targetSegmentId: objectIdSchema.optional(),
  validFrom: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  validTill: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  usageLimitPerCustomer: z.number().int().min(1).default(1),
  totalUsageLimit: z.number().int().min(1).optional(),
  branchScope: z.array(objectIdSchema).default([]),
  active: z.boolean().default(true),
});

export const updateOfferSchema = createOfferSchema.partial();

export const validateOfferSchema = z.object({
  code: z.string().min(1, 'Offer code is required'),
  customerId: objectIdSchema,
  branchId: objectIdSchema.optional(),
  grossPaise: z.number().int().min(0),
  items: z
    .array(
      z.object({
        kind: z.enum(['service', 'product']),
        itemId: objectIdSchema,
        categoryId: objectIdSchema.optional(),
        amountPaise: z.number().int().min(0),
      })
    )
    .optional(),
});

export const createMarketingCampaignSchema = z.object({
  name: z.string().min(1, 'Campaign name is required'),
  numberId: objectIdSchema,
  templateId: objectIdSchema,
  offerId: objectIdSchema.optional(),
  audience: z.object({
    kind: z.enum(['segment', 'selection', 'upload']),
    segmentId: objectIdSchema.optional(),
    segmentCriteria: segmentCriteriaSchema.optional(),
    customerIds: z.array(objectIdSchema).optional(),
    uploadKey: z.string().optional(),
  }),
  variableMap: z.record(z.string()).default({}),
  scheduledAt: z.string().datetime().optional(),
});

export const updateMarketingCampaignSchema = createMarketingCampaignSchema.partial();

export const scheduleCampaignSchema = z.object({
  scheduledAt: z.string().datetime(),
});

