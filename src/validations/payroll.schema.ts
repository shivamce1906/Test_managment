import { z } from 'zod';
import { objectIdSchema, isoDateSchema } from './common.schema';

export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM');

export const createPayrollRunSchema = z.object({
  month: monthSchema,
});

export const adjustPayrollLineSchema = z.object({
  staffId: objectIdSchema,
  field: z.enum([
    'salaryPaise', 'commissionPaise', 'overtimePaise', 'tipsPaise', 'incentivesPaise',
    'advancePaise', 'pfPaise', 'esiPaise', 'ptPaise', 'otherDeductionPaise',
  ]),
  deltaPaise: z.number().int().refine((val) => val !== 0, 'Delta must be non-zero'),
  reason: z.string().min(1, 'Reason for adjustment is mandatory'),
});

export const markPayrollPaidSchema = z.object({
  staffIds: z.array(objectIdSchema).optional(), // Blank = all staff in run
  mode: z.enum(['bank', 'cash', 'upi', 'cheque']).default('bank'),
  date: isoDateSchema,
});

export const payrollRunsQuerySchema = z.object({ year: z.string().regex(/^\d{4}$/).optional() });
export const payslipParamsSchema = z.object({ id: objectIdSchema, staffId: objectIdSchema });
