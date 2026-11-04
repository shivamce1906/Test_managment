import { z } from 'zod';
import { addressSchema, isoDateSchema, objectIdSchema } from './common.schema';

const stageSchema = z.enum(['new', 'contacted', 'interested', 'booked', 'lost']);

/** Same details as a customer, so converting copies them over; a lead's address may be partial. */
const leadDetails = {
  name: z.string().trim().optional(),
  phone: z.string().min(10, 'Valid 10-digit phone is required'),
  email: z.string().email().optional().or(z.literal('')),
  gender: z.enum(['male', 'female', 'other']).optional(),
  dob: isoDateSchema.refine((v) => v <= new Date().toISOString().slice(0, 10), 'Date of birth cannot be in the future').optional(),
  anniversary: isoDateSchema.optional(),
  address: addressSchema.partial().optional(),
  serviceIds: z.array(objectIdSchema),
  budgetPaise: z.number().int().nonnegative().optional(),
  assignedTo: objectIdSchema.optional(),
  followUpDate: isoDateSchema.optional(),
};

export const createLeadSchema = z.object({
  branchId: objectIdSchema,
  ...leadDetails,
  source: z.enum(['whatsapp', 'walk_in', 'phone']).default('phone'),
  serviceIds: leadDetails.serviceIds.default([]),
  /** Becomes the first note in the timeline */
  notes: z.string().trim().optional(),
});

export const updateLeadSchema = z
  .object({
    branchId: objectIdSchema,
    ...leadDetails,
    source: z.enum(['whatsapp', 'walk_in', 'phone']),
    stage: stageSchema,
    lostReason: z.string().trim(),
    assignedTo: objectIdSchema.nullable(),
    followUpDate: isoDateSchema.nullable(),
  })
  .partial();

export const leadFollowUpSchema = z.object({
  channel: z.enum(['call', 'whatsapp', 'visit', 'other']).default('call'),
  outcome: z.enum(['no_answer', 'call_back', 'interested', 'not_interested', 'booked', 'other']),
  note: z.string().trim().optional(),
  /** Next follow-up; leave out to clear it */
  nextFollowUpDate: isoDateSchema.optional(),
});

export const leadNoteSchema = z.object({
  text: z.string().trim().min(1, 'Note cannot be empty'),
});

export const listLeadsQuerySchema = z.object({
  branchId: objectIdSchema.optional(),
  stage: stageSchema.optional(),
  source: z.enum(['whatsapp', 'walk_in', 'phone']).optional(),
  assignedTo: objectIdSchema.optional(),
  followUpDate: isoDateSchema.optional(),
  /** today = follow-up due today; overdue = due before today (open leads only) */
  due: z.enum(['today', 'overdue']).optional(),
  search: z.string().trim().optional(),
});
