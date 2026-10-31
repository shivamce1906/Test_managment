import { z } from 'zod';
import { objectIdSchema, isoDateSchema } from './common.schema';

export const appointmentLineSchema = z.object({
  serviceId: objectIdSchema,
  staffId: objectIdSchema.optional(), // blank = any available
  start: z.string().datetime(), // ISO 8601 UTC string
});

export const inlineCustomerSchema = z.object({
  name: z.string().min(1, 'Customer name is required'),
  phone: z.string().min(10, 'Valid 10-digit phone number is required'),
});

export const createAppointmentSchema = z.object({
  customerId: objectIdSchema.optional(),
  newCustomer: inlineCustomerSchema.optional(),
  lines: z.array(appointmentLineSchema).min(1, 'At least one service is required'),
  source: z.enum(['walk_in', 'phone', 'whatsapp']).default('phone'),
  notes: z.string().optional(),
  notify: z.boolean().default(true),
}).refine((data) => data.customerId || data.newCustomer, {
  message: 'Either customerId or newCustomer must be provided',
});

export const walkInAppointmentSchema = z.object({
  customerId: objectIdSchema.optional(),
  newCustomer: inlineCustomerSchema.optional(),
  serviceIds: z.array(objectIdSchema).min(1, 'At least one service is required'),
  notes: z.string().optional(),
}).refine((data) => data.customerId || data.newCustomer, {
  message: 'Either customerId or newCustomer must be provided',
});
export const createWalkInSchema = walkInAppointmentSchema;

export const updateAppointmentSchema = z.object({
  lines: z.array(appointmentLineSchema).min(1).optional(),
  notes: z.string().optional(),
  __v: z.number().int(),
}).refine((b) => b.lines !== undefined || b.notes !== undefined, { message: 'Send lines and/or notes' });

export const appointmentStatusSchema = z.object({
  status: z.enum(['booked', 'confirmed', 'arrived', 'in_service', 'completed', 'billed', 'cancelled', 'no_show']),
  reason: z.string().optional(),
});
export const updateAppointmentStatusSchema = appointmentStatusSchema;


export const createStaffBlockSchema = z.object({
  staffId: objectIdSchema,
  start: z.string().datetime(),
  end: z.string().datetime(),
  reason: z.string().min(1, 'Reason is required'),
}).refine((b) => new Date(b.end) > new Date(b.start), { path: ['end'], message: 'end must be after start' });

export const listAppointmentsQuerySchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  staffId: objectIdSchema.optional(),
  customerId: objectIdSchema.optional(),
  status: z.enum(['booked', 'confirmed', 'arrived', 'in_service', 'completed', 'billed', 'cancelled', 'no_show']).optional(),
}).refine((q) => !q.from || !q.to || (q.to >= q.from && (Date.parse(q.to) - Date.parse(q.from)) / 86400000 <= 31), {
  path: ['to'],
  message: 'to must be on or after from, at most 31 days later',
});

export const availabilityQuerySchema = z.object({
  serviceId: objectIdSchema,
  date: isoDateSchema,
  staffId: objectIdSchema.optional(),
  stepMin: z.coerce.number().int().refine((n) => [5, 10, 15, 30, 60].includes(n), 'stepMin must be 5, 10, 15, 30 or 60').optional(),
});
