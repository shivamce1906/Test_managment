import { z } from 'zod';
import { objectIdSchema } from './common.schema';

export const createPayrollRunSchema = z.object({
  month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/, 'month must be YYYY-MM'),
});

export const adjustPayrollLineSchema = z.object({
  staffId: objectIdSchema,
  field: z.string().min(1, 'Field name is required'),
  deltaPaise: z.number().int().refine((val) => val !== 0, 'Delta must be non-zero'),
  reason: z.string().min(1, 'Reason for adjustment is mandatory'),
});

export const markPayrollPaidSchema = z.object({
  staffIds: z.array(objectIdSchema).optional(), // Blank = all staff in run
  mode: z.enum(['bank', 'cash', 'upi', 'cheque']).default('bank'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
