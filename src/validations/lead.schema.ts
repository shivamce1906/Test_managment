import { z } from 'zod';
import { objectIdSchema } from './common.schema';

export const createLeadSchema = z.object({
  branchId: objectIdSchema,
  name: z.string().optional(),
  phone: z.string().min(10, 'Valid 10-digit phone is required'),
  source: z.enum(['whatsapp', 'walk_in', 'phone']).default('phone'),
  serviceIds: z.array(objectIdSchema).default([]),
  budgetPaise: z.number().int().nonnegative().optional(),
  assignedTo: objectIdSchema.optional(),
  followUpDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().optional(),
});

export const updateLeadSchema = z.object({
  branchId: objectIdSchema.optional(),
  name: z.string().optional(),
  phone: z.string().min(10).optional(),
  serviceIds: z.array(objectIdSchema).optional(),
  budgetPaise: z.number().int().nonnegative().optional(),
  stage: z.enum(['new', 'contacted', 'interested', 'booked', 'lost']).optional(),
  lostReason: z.string().optional(),
  assignedTo: objectIdSchema.optional(),
  followUpDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().optional(),
}).refine((data) => {
  if (data.stage === 'lost') {
    return !!data.lostReason && data.lostReason.trim().length > 0;
  }
  return true;
}, {
  message: 'lostReason is required when stage is lost',
  path: ['lostReason'],
});
