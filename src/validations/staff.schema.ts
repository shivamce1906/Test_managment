import { z } from 'zod';
import { objectIdSchema } from './common.schema';
import { commissionRuleSchema } from './catalogue.schema';

export const createStaffSchema = z.object({
  branchId: objectIdSchema,
  name: z.string().min(1, 'Staff name is required'),
  phone: z.string().min(10, 'Valid 10-digit phone is required'),
  designation: z.enum(['stylist', 'senior_stylist', 'beautician', 'receptionist', 'manager', 'helper', 'other']),
  joiningDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'joiningDate must be YYYY-MM-DD'),
  serviceIds: z.array(objectIdSchema).default([]),
  salary: z.object({
    type: z.enum(['monthly', 'none']).default('monthly'),
    amountPaise: z.number().int().nonnegative().default(0),
  }),
  commission: z.object({
    service: commissionRuleSchema.optional(),
    productBps: z.number().int().nonnegative().optional(),
    overtimePerHourPaise: z.number().int().nonnegative().optional(),
  }).optional(),
  statutory: z.object({
    pf: z.boolean().default(false),
    esi: z.boolean().default(false),
    pt: z.boolean().default(false),
  }).default({ pf: false, esi: false, pt: false }),
  bankRef: z.object({
    bank: z.string(),
    last4: z.string().length(4),
  }).optional(),
  documents: z.array(z.object({
    kind: z.string(),
    s3Key: z.string(),
  })).default([]),
  emergencyContact: z.object({
    name: z.string(),
    phone: z.string(),
  }).optional(),
  status: z.enum(['active', 'exited']).default('active'),
});

export const updateStaffSchema = createStaffSchema.partial().extend({
  exitDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  exitReason: z.string().optional(),
});

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:mm');

// A working slot needs start < end; an off slot needs no times. "HH:mm" strings compare correctly.
const shiftSlot = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ ...shape, start: hhmm.optional(), end: hhmm.optional(), off: z.boolean() }).superRefine((slot: any, ctx) => {
    if (slot.off) return;
    if (!slot.start || !slot.end) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['start'], message: 'start and end are required on a working day' });
    } else if (slot.start >= slot.end) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['end'], message: 'end must be after start' });
    }
  });

export const updateRosterSchema = z.object({
  weekly: z.array(shiftSlot({ day: z.number().int().min(0).max(6) })).refine(
    (days) => new Set(days.map((d: any) => d.day)).size === days.length,
    'Each weekday may appear only once'
  ),
  overrides: z.array(shiftSlot({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })).default([]),
});

export const markAttendanceSchema = z.object({
  entries: z.array(z.object({
    staffId: objectIdSchema,
    status: z.enum(['present', 'late', 'half_day', 'absent', 'leave', 'week_off', 'holiday']).optional(),
    inAt: z.string().datetime().optional(),
    outAt: z.string().datetime().optional(),
    note: z.string().optional(),
  })).min(1, 'At least one attendance entry required'),
  reason: z.string().optional(), // Required when updating past dates
});

export const createLeaveSchema = z.object({
  staffId: objectIdSchema,
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: z.enum(['paid', 'unpaid']),
  reason: z.string().optional(),
}).refine((l) => l.to >= l.from, { path: ['to'], message: 'to must be on or after from' });

export const updateLeaveStatusSchema = z.object({
  status: z.enum(['approved', 'rejected']),
});

export const createAdvanceSchema = z.object({
  staffId: objectIdSchema,
  amountPaise: z.number().int().positive('Advance amount must be positive'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  recoveryPerMonthPaise: z.number().int().positive(),
  payFromTill: z.boolean().default(false), // If paid from cash till, creates a till expense
});

export const listStaffQuerySchema = z.object({
  branchId: objectIdSchema.optional(),
  status: z.enum(['active', 'exited']).optional(),
  designation: z.enum(['stylist', 'senior_stylist', 'beautician', 'receptionist', 'manager', 'helper', 'other']).optional(),
  q: z.string().trim().max(100).optional(),
});

export const businessDateQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD').optional(),
});

export const branchParamSchema = z.object({ branchId: objectIdSchema });
