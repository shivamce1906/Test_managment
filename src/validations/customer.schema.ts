import { z } from 'zod';
import { objectIdSchema, addressSchema } from './common.schema';

const isValidCalendarDate = (val?: string) => {
  if (!val) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return false;
  const [y, m, d] = val.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

export const createCustomerSchema = z
  .object({
    name: z.string().min(1, 'Name is required'),
    phone: z.string().regex(/^\+?[0-9]{10,12}$/, 'Valid phone number is required'),
    altPhone: z.string().regex(/^\+?[0-9]{10,12}$/, 'Valid phone number is required').optional().or(z.literal('')),
    email: z.string().email().optional().or(z.literal('')),
    gender: z.enum(['male', 'female', 'other']).optional(),
    dob: z.string().refine(isValidCalendarDate, 'dob must be a valid calendar date (YYYY-MM-DD)').optional(),
    anniversary: z.string().refine(isValidCalendarDate, 'anniversary must be a valid calendar date (YYYY-MM-DD)').optional(),
    address: addressSchema.optional(),
    source: z.enum(['walk_in', 'phone', 'whatsapp', 'referral']).default('walk_in'),
    referredBy: objectIdSchema.optional(),
    tags: z.array(z.string()).default([]),
    waOptIn: z.boolean().default(true),
    doNotMessage: z.boolean().default(false),
    notes: z.string().optional(),
  })
  .strict();

export const updateCustomerSchema = createCustomerSchema.partial().strict();

export const customerServiceNoteSchema = z.object({
  text: z.string().min(1, 'Note text is required'),
  colourFormula: z.string().optional(),
  staffId: objectIdSchema.optional(),
});
export const addServiceNoteSchema = customerServiceNoteSchema;

export const mergeCustomerSchema = z.object({
  primaryId: objectIdSchema,
  duplicateId: objectIdSchema,
});
