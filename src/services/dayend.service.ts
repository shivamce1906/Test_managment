import { Types } from 'mongoose';
import {
  Expense,
  RecurringExpense,
  PettyCashEntry,
  DayClosure,
  Bill,
  DueReceipt,
  Branch,
  withTransaction,
} from '../models';
import { AppError, ErrorCode, getBusinessDate } from '../utils';
import { RequestContext, toObjectId } from './context';
import { logAction } from './audit.service';
import { generateDayEndPdf, uploadPdf } from '../integrations';
import { z } from 'zod';
import {
  createExpenseSchema,
  updateExpenseSchema,
  createRecurringExpenseSchema,
  createPettyCashSchema,
  submitDayClosureSchema,
  reopenDayClosureSchema,
} from '../validations';

// ----------------------------------------------------
// Expenses
// ----------------------------------------------------

export async function createExpense(
  ctx: RequestContext,
  branchId: string | Types.ObjectId,
  input: z.infer<typeof createExpenseSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const businessDate = input.businessDate || getBusinessDate();

  // Check if day is already closed & approved
  const closure = await DayClosure.findOne({
    businessId: ctx.businessId,
    branchId: toObjectId(branchId),
    businessDate,
    status: 'approved',
  });
  if (closure) {
    throw new AppError(400, ErrorCode.DAY_CLOSED, 'Cannot add expense to an approved closed day');
  }

  const expense = await Expense.create({
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(branchId),
    businessDate,
    category: input.category,
    amountPaise: input.amountPaise,
    mode: input.mode,
    paidFrom: input.paidFrom,
    note: input.note,
    receiptKey: input.receiptKey,
    recurringId: input.recurringId ? toObjectId(input.recurringId) : undefined,
    createdBy: toObjectId(ctx.userId),
    updatedBy: toObjectId(ctx.userId),
  });

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(branchId),
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'expense.created',
    targetType: 'expense',
    targetId: expense._id,
    after: expense.toObject(),
  });

  return expense;
}

export async function updateExpense(
  ctx: RequestContext,
  expenseId: string | Types.ObjectId,
  input: z.infer<typeof updateExpenseSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const expense = await Expense.findOne({ _id: toObjectId(expenseId), businessId: toObjectId(ctx.businessId) });
  if (!expense) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Expense not found');
  }

  const closure = await DayClosure.findOne({
    businessId: toObjectId(ctx.businessId),
    branchId: expense.branchId,
    businessDate: expense.businessDate,
    status: 'approved',
  });
  if (closure) {
    throw new AppError(400, ErrorCode.DAY_CLOSED, 'Cannot modify expense on an approved closed day');
  }

  const before = expense.toObject();

  if (input.category) expense.category = input.category;
  if (input.amountPaise !== undefined) expense.amountPaise = input.amountPaise;
  if (input.mode) expense.mode = input.mode;
  if (input.paidFrom) expense.paidFrom = input.paidFrom;
  if (input.note !== undefined) expense.note = input.note;
  if (input.receiptKey !== undefined) expense.receiptKey = input.receiptKey;

  (expense as any).updatedBy = toObjectId(ctx.userId);
  await expense.save();

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: expense.branchId,
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'expense.updated',
    targetType: 'expense',
    targetId: expense._id,
    before,
    after: expense.toObject(),
  });

  return expense;
}

export async function deleteExpense(
  ctx: RequestContext,
  expenseId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const expense = await Expense.findOne({ _id: toObjectId(expenseId), businessId: toObjectId(ctx.businessId) });
  if (!expense) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Expense not found');
  }

  const closure = await DayClosure.findOne({
    businessId: toObjectId(ctx.businessId),
    branchId: expense.branchId,
    businessDate: expense.businessDate,
    status: 'approved',
  });
  if (closure) {
    throw new AppError(400, ErrorCode.DAY_CLOSED, 'Cannot delete expense on an approved closed day');
  }

  const before = expense.toObject();
  expense.deletedAt = new Date();
  (expense as any).updatedBy = toObjectId(ctx.userId);
  await expense.save();

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: expense.branchId,
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'expense.deleted',
    targetType: 'expense',
    targetId: expense._id,
    before,
  });

  return { success: true };
}

export async function getExpenses(
  ctx: RequestContext,
  branchId: string | Types.ObjectId,
  filter?: { fromDate?: string; toDate?: string; category?: string }
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const query: any = { businessId: toObjectId(ctx.businessId), branchId: toObjectId(branchId), deletedAt: { $exists: false } };
  if (filter?.fromDate || filter?.toDate) {
    query.businessDate = {};
    if (filter?.fromDate) query.businessDate.$gte = filter.fromDate;
    if (filter?.toDate) query.businessDate.$lte = filter.toDate;
  }
  if (filter?.category) query.category = filter.category;

  return Expense.find(query).sort({ businessDate: -1, createdAt: -1 });
}

// ----------------------------------------------------
// Recurring Expenses
// ----------------------------------------------------

export async function createRecurringExpense(
  ctx: RequestContext,
  branchId: string | Types.ObjectId,
  input: z.infer<typeof createRecurringExpenseSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const rec = await RecurringExpense.create({
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(branchId),
    category: input.category,
    amountPaise: input.amountPaise,
    dayOfMonth: input.dayOfMonth,
    active: input.active,
    createdBy: toObjectId(ctx.userId),
    updatedBy: toObjectId(ctx.userId),
  });

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(branchId),
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'recurring_expense.created',
    targetType: 'recurringExpense',
    targetId: rec._id,
    after: rec.toObject(),
  });

  return rec;
}

export async function getRecurringExpenses(
  ctx: RequestContext,
  branchId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  return RecurringExpense.find({ businessId: toObjectId(ctx.businessId), branchId: toObjectId(branchId) });
}

// ----------------------------------------------------
// Petty Cash
// ----------------------------------------------------

export async function createPettyCashEntry(
  ctx: RequestContext,
  branchId: string | Types.ObjectId,
  input: z.infer<typeof createPettyCashSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const businessDate = getBusinessDate();

  const entry = await PettyCashEntry.create({
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(branchId),
    businessDate,
    type: input.type,
    amountPaise: input.amountPaise,
    createdBy: toObjectId(ctx.userId),
    updatedBy: toObjectId(ctx.userId),
  });

  return entry;
}

export async function getPettyCashEntries(
  ctx: RequestContext,
  branchId: string | Types.ObjectId,
  businessDate?: string
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const query: any = { businessId: toObjectId(ctx.businessId), branchId: toObjectId(branchId) };
  if (businessDate) query.businessDate = businessDate;

  return PettyCashEntry.find(query).sort({ createdAt: -1 });
}

// ----------------------------------------------------
// Day End Closures & Expected Computation (BR-06)
// ----------------------------------------------------

export async function calculateExpected(
  ctxOrBusinessId: RequestContext | Types.ObjectId | string,
  branchId: string | Types.ObjectId,
  businessDate: string
) {
  const businessId =
    typeof ctxOrBusinessId === 'object' && ctxOrBusinessId !== null && 'businessId' in ctxOrBusinessId
      ? ctxOrBusinessId.businessId!
      : (ctxOrBusinessId as string | Types.ObjectId);
  const bId = toObjectId(businessId);
  const brId = toObjectId(branchId);

  // 1. Opening Cash Float
  const floatEntry = await PettyCashEntry.findOne({
    businessId: bId,
    branchId: brId,
    businessDate,
    type: 'float',
  });
  const openingCashFloat = floatEntry ? floatEntry.amountPaise : 0;

  // 2. Bills on this date
  const bills = await Bill.find({
    businessId: bId,
    branchId: brId,
    businessDate,
    status: { $in: ['paid', 'partly_paid', 'cancelled', 'refunded', 'partly_refunded'] },
  });

  let cashSales = 0;
  let upiSales = 0;
  let cardSales = 0;
  let cashTipsPaid = 0;
  let cashRefunds = 0;
  let upiRefunds = 0;
  let cardRefunds = 0;

  for (const bill of bills) {
    if (bill.status === 'paid' || bill.status === 'partly_paid') {
      for (const p of bill.payments) {
        if (p.mode === 'cash') cashSales += p.amountPaise;
        else if (p.mode === 'upi') upiSales += p.amountPaise;
        else if (p.mode === 'card') cardSales += p.amountPaise;
      }
      for (const tip of bill.tips || []) {
        if (tip.payout === 'cash_today') {
          cashTipsPaid += tip.amountPaise;
        }
      }
    }

    for (const r of bill.refunds || []) {
      if (r.mode === 'cash') cashRefunds += r.amountPaise;
      else if (r.mode === 'upi') upiRefunds += r.amountPaise;
      else if (r.mode === 'card') cardRefunds += r.amountPaise;
    }
  }

  // 3. Due Receipts collected on this date
  const dueReceipts = await DueReceipt.find({
    businessId: bId,
    branchId: brId,
    businessDate,
  });

  let dueCash = 0;
  let dueUpi = 0;
  let dueCard = 0;

  for (const dr of dueReceipts) {
    for (const p of dr.payments) {
      if (p.mode === 'cash') dueCash += p.amountPaise;
      else if (p.mode === 'upi') dueUpi += p.amountPaise;
      else if (p.mode === 'card') dueCard += p.amountPaise;
    }
  }

  // 4. Expenses paid in cash from till
  const expenses = await Expense.find({
    businessId: bId,
    branchId: brId,
    businessDate,
    deletedAt: { $exists: false },
  });

  let cashExpenses = 0;
  for (const exp of expenses) {
    if (exp.mode === 'cash' && exp.paidFrom === 'till') {
      cashExpenses += exp.amountPaise;
    }
  }

  // 5. Cash deposits to bank/owner
  const deposits = await PettyCashEntry.find({
    businessId: bId,
    branchId: brId,
    businessDate,
    type: 'deposit',
  });

  let cashDeposits = 0;
  for (const dep of deposits) {
    cashDeposits += dep.amountPaise;
  }

  const expectedCash = openingCashFloat + cashSales + dueCash - cashRefunds - cashExpenses - cashTipsPaid - cashDeposits;
  const expectedUpi = upiSales + dueUpi - upiRefunds;
  const expectedCard = cardSales + dueCard - cardRefunds;

  return {
    cashPaise: expectedCash,
    upiPaise: expectedUpi,
    cardPaise: expectedCard,
    breakdown: {
      openingCashFloat,
      cashSales,
      dueCash,
      cashRefunds,
      cashExpenses,
      cashTipsPaid,
      cashDeposits,
      upiSales,
      dueUpi,
      upiRefunds,
      cardSales,
      dueCard,
      cardRefunds,
    },
  };
}

export async function getDayClosure(
  ctx: RequestContext,
  branchId: string | Types.ObjectId,
  businessDate: string
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const expected = await calculateExpected(ctx.businessId, branchId, businessDate);

  let closure = await DayClosure.findOne({
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(branchId),
    businessDate,
  });

  if (!closure) {
    closure = await DayClosure.create({
      businessId: toObjectId(ctx.businessId),
      branchId: toObjectId(branchId),
      businessDate,
      expected: {
        cashPaise: expected.cashPaise,
        upiPaise: expected.upiPaise,
        cardPaise: expected.cardPaise,
      },
      status: 'open',
      createdBy: toObjectId(ctx.userId),
      updatedBy: toObjectId(ctx.userId),
    });
  } else if (closure.status === 'open') {
    closure.expected = {
      cashPaise: expected.cashPaise,
      upiPaise: expected.upiPaise,
      cardPaise: expected.cardPaise,
    };
    await closure.save();
  }

  return { closure, breakdown: expected.breakdown };
}

export async function submitDayClosure(
  ctx: RequestContext,
  branchId: string | Types.ObjectId,
  businessDate: string,
  input: z.infer<typeof submitDayClosureSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  let closure = await DayClosure.findOne({
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(branchId),
    businessDate,
  });

  if (closure && closure.status === 'approved') {
    throw new AppError(400, ErrorCode.DAY_CLOSED, 'Cannot resubmit an approved day closure');
  }

  const expected = await calculateExpected(ctx.businessId, branchId, businessDate);

  const diffCash = input.cashPaise - expected.cashPaise;
  const diffUpi = input.upiPaise - expected.upiPaise;
  const diffCard = input.cardPaise - expected.cardPaise;

  if ((diffCash !== 0 || diffUpi !== 0 || diffCard !== 0) && !input.diffReason) {
    throw new AppError(
      400,
      ErrorCode.BAD_REQUEST,
      'A reason is mandatory when there is a cash, UPI, or card discrepancy'
    );
  }

  if (!closure) {
    closure = new DayClosure({
      businessId: toObjectId(ctx.businessId),
      branchId: toObjectId(branchId),
      businessDate,
      createdBy: toObjectId(ctx.userId),
    });
  }

  closure.expected = {
    cashPaise: expected.cashPaise,
    upiPaise: expected.upiPaise,
    cardPaise: expected.cardPaise,
  };
  closure.counted = {
    cashPaise: input.cashPaise,
    denominations: input.denominations,
    upiPaise: input.upiPaise,
    cardPaise: input.cardPaise,
  };
  closure.diff = {
    cashPaise: diffCash,
    upiPaise: diffUpi,
    cardPaise: diffCard,
  };
  closure.diffReason = input.diffReason;
  closure.status = 'submitted';
  closure.submittedBy = toObjectId(ctx.userId);
  (closure as any).updatedBy = toObjectId(ctx.userId);

  await closure.save();

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(branchId),
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'day_closure.submitted',
    targetType: 'dayClosure',
    targetId: closure._id,
    meta: { businessDate, diff: closure.diff, diffReason: input.diffReason },
  });

  return closure;
}

export async function approveDayClosure(
  ctx: RequestContext,
  branchId: string | Types.ObjectId,
  businessDate: string
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const closure = await DayClosure.findOne({
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(branchId),
    businessDate,
  });

  if (!closure) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Day closure not found');
  }

  if (closure.status === 'approved') {
    return closure;
  }

  closure.status = 'approved';
  closure.approvedBy = toObjectId(ctx.userId);
  closure.approvedAt = new Date();
  (closure as any).updatedBy = toObjectId(ctx.userId);

  // Generate Day End Summary PDF
  const branch = await Branch.findOne({ _id: toObjectId(branchId), businessId: toObjectId(ctx.businessId) });
  const pdfBuffer = await generateDayEndPdf({
    businessDate,
    branchName: branch?.name || 'Branch',
    expectedCashPaise: closure.expected.cashPaise,
    countedCashPaise: closure.counted?.cashPaise || closure.expected.cashPaise,
    diffCashPaise: closure.diff?.cashPaise || 0,
    upiPaise: closure.expected.upiPaise,
    cardPaise: closure.expected.cardPaise,
  });

  const pdfKey = `dayend/${ctx.businessId}/${branchId}/${businessDate}.pdf`;
  await uploadPdf(pdfKey, pdfBuffer);

  closure.report = {
    sentAt: new Date(),
    pdfKey,
    closedAtSend: true,
  };

  await closure.save();

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(branchId),
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'day_closure.approved',
    targetType: 'dayClosure',
    targetId: closure._id,
    meta: { businessDate, pdfKey },
  });

  return closure;
}

export async function reopenDayClosure(
  ctx: RequestContext,
  branchId: string | Types.ObjectId,
  businessDate: string,
  input: z.infer<typeof reopenDayClosureSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  if (ctx.role !== 'owner' && ctx.role !== 'super_admin' && ctx.role !== 'superadmin') {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'Only business owner can reopen an approved day closure');
  }

  const closure = await DayClosure.findOne({
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(branchId),
    businessDate,
  });

  if (!closure) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Day closure not found');
  }

  closure.status = 'open';
  closure.reopenLog.push({
    by: toObjectId(ctx.userId),
    at: new Date(),
    reason: input.reason,
  });
  (closure as any).updatedBy = toObjectId(ctx.userId);

  await closure.save();

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(branchId),
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'day_closure.reopened',
    targetType: 'dayClosure',
    targetId: closure._id,
    meta: { businessDate, reason: input.reason },
  });

  return closure;
}
