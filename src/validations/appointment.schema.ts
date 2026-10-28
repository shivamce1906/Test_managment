import { z } from 'zod';
import { objectIdSchema } from './common.schema';

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
  lines: z.array(appointmentLineSchema).optional(),
  notes: z.string().optional(),
  __v: z.number().int(),
});

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
}).refine((b) => new Date(b.end) > new Date(b.start), {
  message: 'end must be after start',
});
