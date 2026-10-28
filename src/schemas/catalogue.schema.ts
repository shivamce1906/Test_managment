import { z } from 'zod';
import { objectIdSchema, addressSchema } from './common.schema';

export const commissionRuleSchema = z.object({
  type: z.enum(['pct', 'fixed', 'slab']),
  value: z.number().nonnegative().optional(), // bps if pct, paise if fixed
  slabs: z.array(z.object({
    uptoPaise: z.number().int().positive(),
    bps: z.number().int().nonnegative(),
  })).optional(),
});

export const createCategorySchema = z.object({
  name: z.string().min(1),
  parentId: objectIdSchema.optional(),
  gender: z.enum(['men', 'women', 'unisex']),
  order: z.number().int().default(0),
  active: z.boolean().default(true),
});

export const updateCategorySchema = z.object({
  name: z.string().min(1).optional(),
  parentId: objectIdSchema.optional().nullable(),
  gender: z.enum(['men', 'women', 'unisex']).optional(),
  order: z.number().int().optional(),
  active: z.boolean().optional(),
});

export const reorderCategoriesSchema = z.object({
  orders: z.array(z.object({
    id: objectIdSchema,
    order: z.number().int(),
  })),
});

export const createServiceSchema = z.object({
  categoryId: objectIdSchema,
  name: z.string().min(1),
  gender: z.enum(['men', 'women', 'unisex']),
  basePricePaise: z.number().int().nonnegative(),
  durationMin: z.number().int().min(5).max(480),
  branchPrices: z.array(z.object({
    branchId: objectIdSchema,
    pricePaise: z.number().int().nonnegative().optional(),
    active: z.boolean().default(true),
  })).optional(),
  consumables: z.array(z.object({
    productId: objectIdSchema,
    qty: z.number().int().positive(),
  })).optional(),
  rebookDays: z.number().int().min(1).max(365).optional(),
  eligibleStaffIds: z.array(objectIdSchema).optional(),
  commission: commissionRuleSchema.optional(),
  active: z.boolean().default(true),
});

export const updateServiceSchema = z.object({
  categoryId: objectIdSchema.optional(),
  name: z.string().min(1).optional(),
  gender: z.enum(['men', 'women', 'unisex']).optional(),
  basePricePaise: z.number().int().nonnegative().optional(),
  durationMin: z.number().int().min(5).max(480).optional(),
  branchPrices: z.array(z.object({
    branchId: objectIdSchema,
    pricePaise: z.number().int().nonnegative().optional(),
    active: z.boolean(),
  })).optional(),
  consumables: z.array(z.object({
    productId: objectIdSchema,
    qty: z.number().int().positive(),
  })).optional(),
  rebookDays: z.number().int().min(1).max(365).optional(),
  eligibleStaffIds: z.array(objectIdSchema).optional(),
  commission: commissionRuleSchema.optional(),
  active: z.boolean().optional(),
});

export const bulkPricePreviewSchema = z.object({
  categoryId: objectIdSchema,
  branchId: objectIdSchema.optional(),
  changeBps: z.number().int(), // e.g. 1000 = +10%, -500 = -5%
});

export const createProductSchema = z.object({
  name: z.string().min(1),
  brand: z.string().optional(),
  category: z.string().optional(),
  type: z.enum(['retail', 'consumable', 'both']),
  sku: z.string().optional(),
  purchaseUnit: z.string().min(1),
  useUnit: z.string().min(1),
  unitsPerPurchase: z.number().int().positive(),
  mrpPaise: z.number().int().nonnegative().optional(),
  sellingPricePaise: z.number().int().nonnegative().optional(),
  purchasePricePaise: z.number().int().nonnegative(),
  hsn: z.string().optional(),
  gstBps: z.number().int().nonnegative().optional(),
  reorderLevels: z.array(z.object({
    branchId: objectIdSchema,
    qty: z.number().int().nonnegative(),
  })).optional(),
  active: z.boolean().default(true),
});

export const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  brand: z.string().optional(),
  category: z.string().optional(),
  type: z.enum(['retail', 'consumable', 'both']).optional(),
  sku: z.string().optional(),
  purchaseUnit: z.string().optional(),
  useUnit: z.string().optional(),
  unitsPerPurchase: z.number().int().positive().optional(),
  mrpPaise: z.number().int().nonnegative().optional(),
  sellingPricePaise: z.number().int().nonnegative().optional(),
  purchasePricePaise: z.number().int().nonnegative().optional(),
  hsn: z.string().optional(),
  gstBps: z.number().int().nonnegative().optional(),
  reorderLevels: z.array(z.object({
    branchId: objectIdSchema,
    qty: z.number().int().nonnegative(),
  })).optional(),
  active: z.boolean().optional(),
});

export const createVendorSchema = z.object({
  name: z.string().min(1),
  contact: z.string().optional(),
  phone: z.string().optional(),
  gstin: z.string().optional(),
  address: addressSchema.optional(),
  terms: z.string().optional(),
});

export const updateVendorSchema = createVendorSchema.partial();

