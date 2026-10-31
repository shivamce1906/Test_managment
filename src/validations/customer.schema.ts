import { z } from 'zod';
import { objectIdSchema, addressSchema, isoDateSchema } from './common.schema';

export const createCustomerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  phone: z.string().min(10, 'Valid 10-digit phone is required'),
  altPhones: z.array(z.string().min(10, 'Valid 10-digit phone is required')).max(3).optional(),
  email: z.string().email().optional().or(z.literal('')),
  gender: z.enum(['male', 'female', 'other']).optional(),
  dob: isoDateSchema.refine((v) => v <= new Date().toISOString().slice(0, 10), 'Date of birth cannot be in the future').optional(),
  anniversary: isoDateSchema.optional(),
  address: addressSchema.optional(),
  source: z.enum(['walk_in', 'phone', 'whatsapp', 'referral']).default('walk_in'),
  referredBy: objectIdSchema.optional(),
  tags: z.array(z.string().trim().min(1)).default([]),
  waOptIn: z.boolean().default(true),
  doNotMessage: z.boolean().default(false),
  notes: z.string().optional(),
});

// No defaults on update: only the fields sent are changed
export const updateCustomerSchema = createCustomerSchema
  .extend({ source: createCustomerSchema.shape.source.removeDefault(), tags: z.array(z.string().trim().min(1)), waOptIn: z.boolean(), doNotMessage: z.boolean() })
  .partial();

export const customerServiceNoteSchema = z.object({
  text: z.string().min(1, 'Note text is required'),
  colourFormula: z.string().optional(),
  staffId: objectIdSchema.optional(),
});
export const addServiceNoteSchema = customerServiceNoteSchema;


// POST /customers/:id/merge sends { duplicateId }; POST /customers/merge also needs primaryId
export const mergeCustomerSchema = z.object({
  primaryId: objectIdSchema.optional(),
  duplicateId: objectIdSchema,
});

export const listCustomersQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  tags: z.union([z.string(), z.array(z.string())]).transform((v) => (Array.isArray(v) ? v : v.split(',')).map((t) => t.trim()).filter(Boolean)).optional(),
  segment: z.enum(['new', 'regular', 'lapsed']).optional(),
  lastVisitFrom: isoDateSchema.optional(),
  lastVisitTo: isoDateSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const customerHistoryQuerySchema = z.object({
  type: z.enum(['bills', 'appointments', 'plans', 'wallet', 'loyalty', 'feedback', 'whatsapp']).optional(),
});
