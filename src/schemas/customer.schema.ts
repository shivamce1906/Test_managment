import { z } from 'zod';
import { objectIdSchema, addressSchema } from './common.schema';

export const createCustomerSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  phone: z.string().min(10, 'Valid 10-digit phone is required'),
  altPhone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  gender: z.enum(['male', 'female', 'other']).optional(),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dob must be YYYY-MM-DD').optional(),
  anniversary: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'anniversary must be YYYY-MM-DD').optional(),
  address: addressSchema.optional(),
  source: z.enum(['walk_in', 'phone', 'whatsapp', 'referral']).default('walk_in'),
  referredBy: objectIdSchema.optional(),
  tags: z.array(z.string()).default([]),
  waOptIn: z.boolean().default(true),
  doNotMessage: z.boolean().default(false),
  notes: z.string().optional(),
});

export const updateCustomerSchema = createCustomerSchema.partial();

export const customerServiceNoteSchema = z.object({
  text: z.string().min(1, 'Note text is required'),
  colourFormula: z.string().optional(),
  staffId: objectIdSchema.optional(),
});
export const addServiceNoteSchema = customerServiceNoteSchema;


export const mergeCustomerSchema = z.object({
  duplicateId: objectIdSchema,
});
