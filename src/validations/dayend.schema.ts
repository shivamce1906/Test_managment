import { z } from 'zod';
import { objectIdSchema } from './common.schema';

export const createExpenseSchema = z.object({
  category: z.enum(['rent', 'electricity', 'salary_advance', 'tea_snacks', 'repairs', 'marketing', 'other']),
  amountPaise: z.number().int().positive('Amount must be positive'),
  mode: z.enum(['cash', 'upi', 'card', 'bank']),
  paidFrom: z.enum(['till', 'petty_cash', 'bank']),
  note: z.string().optional(),
  receiptKey: z.string().optional(),
  recurringId: objectIdSchema.optional(),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const updateExpenseSchema = createExpenseSchema.partial();

export const createRecurringExpenseSchema = z.object({
  category: z.enum(['rent', 'electricity', 'salary_advance', 'tea_snacks', 'repairs', 'marketing', 'other']),
  amountPaise: z.number().int().positive(),
  dayOfMonth: z.number().int().min(1).max(31),
  active: z.boolean().default(true),
});

export const createPettyCashSchema = z.object({
  type: z.enum(['float', 'topup', 'expense', 'deposit']),
  amountPaise: z.number().int().positive(),
});

export const submitDayClosureSchema = z.object({
  denominations: z.record(z.number().int().nonnegative()),
  cashPaise: z.number().int().nonnegative(),
  upiPaise: z.number().int().nonnegative(),
  cardPaise: z.number().int().nonnegative(),
  diffReason: z.string().optional(),
});

export const approveDayClosureSchema = z.object({});

export const reopenDayClosureSchema = z.object({
  reason: z.string().min(1, 'Reason is mandatory for reopening a closed day'),
});
