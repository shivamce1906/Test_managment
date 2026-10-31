import { Types } from 'mongoose';
import {
  PayrollRun,
  Payslip,
  Staff,
  Attendance,
  Bill,
  Advance,
  Leave,
  Business,
  Branch,
  withTransaction,
} from '../models';
import { AppError, ErrorCode, getDaysInMonth, getBusinessDate } from '../utils';
import { RequestContext, toObjectId } from './context';
import { logAction } from './audit.service';
import { renderPayslipPdf, uploadPdf } from '../integrations';
import { z } from 'zod';
import {
  createPayrollRunSchema,
  adjustPayrollLineSchema,
  markPayrollPaidSchema,
} from '../validations';

/** Bills whose commission and tips count towards payroll (a cancelled bill's do not). */
const PAYROLL_BILL_STATUSES = ['paid', 'partly_paid', 'partly_refunded', 'refunded'];

const EARNINGS = ['salaryPaise', 'commissionPaise', 'overtimePaise', 'tipsPaise', 'incentivesPaise'] as const;
const DEDUCTIONS = ['advancePaise', 'pfPaise', 'esiPaise', 'ptPaise', 'otherDeductionPaise'] as const;

const lineGross = (l: any) => EARNINGS.reduce((a, k) => a + (l[k] || 0), 0);
const lineDeductions = (l: any) => DEDUCTIONS.reduce((a, k) => a + (l[k] || 0), 0);

function setTotals(run: any): void {
  for (const l of run.lines) l.netPaise = Math.max(0, lineGross(l) - lineDeductions(l));
  run.totals = {
    grossPaise: run.lines.reduce((a: number, l: any) => a + lineGross(l), 0),
    deductionsPaise: run.lines.reduce((a: number, l: any) => a + lineDeductions(l), 0),
    netPaise: run.lines.reduce((a: number, l: any) => a + l.netPaise, 0),
  };
}

/** Managers only see their own branches' payroll; another branch's run is a 404. */
async function loadRun(ctx: RequestContext, runId: string | Types.ObjectId, session?: any) {
  const run = await PayrollRun.findOne({ _id: toObjectId(runId), businessId: toObjectId(ctx.businessId!) }).session(session || null);
  if (!run || (ctx.role === 'manager' && !ctx.branchIds.includes(run.branchId.toString()))) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Payroll run not found');
  }
  return run;
}

/** Dates "YYYY-MM-DD" from..to inclusive. */
function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Builds (or rebuilds) the draft for a branch and month. Per staff member:
 * - paid days = days employed in the month − absent − ½ × half days − approved unpaid leave
 *   (days without an attendance record count as worked);
 * - salary = monthly salary × paid days ÷ days in month;
 * - commission and payroll tips from this month's bills of the branch;
 * - overtime at overtimePerHourPaise, in half-hour steps;
 * - open advances recovered up to recoveryPerMonthPaise;
 * - PF / ESI / PT only when switched on for the business AND for the staff member, using the
 *   business's rates, wage ceilings and PT slabs.
 */
export async function createMonthlyRun(
  ctx: RequestContext,
  branchId: string | Types.ObjectId,
  input: z.infer<typeof createPayrollRunSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  const businessId = toObjectId(ctx.businessId);
  const { month } = input;
  if (month > getBusinessDate().slice(0, 7)) {
    throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'Payroll cannot be run for a future month', { fields: { month: 'Future month' } });
  }

  const existing = await PayrollRun.findOne({ businessId, branchId: toObjectId(branchId), month });
  if (existing && (existing.status === 'locked' || existing.status === 'paid')) {
    throw new AppError(409, ErrorCode.PAYROLL_LOCKED, `Payroll for ${month} is already ${existing.status}`);
  }

  const totalDays = getDaysInMonth(month);
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(totalDays).padStart(2, '0')}`;

  const [business, staffList, bills] = await Promise.all([
    Business.findById(businessId).select('payroll'),
    // Active staff, plus anyone who left during this month (paid up to their exit date)
    Staff.find({
      businessId,
      branchId: toObjectId(branchId),
      joiningDate: { $lte: monthEnd },
      $or: [{ status: 'active' }, { exitDate: { $gte: monthStart } }],
    }).sort({ name: 1 }),
    Bill.find({
      businessId,
      branchId: toObjectId(branchId),
      businessDate: { $gte: monthStart, $lte: monthEnd },
      status: { $in: PAYROLL_BILL_STATUSES },
    }),
  ]);
  const payroll: any = business?.payroll || {};

  const lines: any[] = [];
  for (const staff of staffList) {
    // 1. Paid days within the employment window
    const from = staff.joiningDate > monthStart ? staff.joiningDate : monthStart;
    const to = staff.exitDate && staff.exitDate < monthEnd ? staff.exitDate : monthEnd;
    const employed = new Set(datesBetween(from, to));

    const [attendance, unpaidLeaves] = await Promise.all([
      Attendance.find({ businessId, staffId: staff._id, businessDate: { $gte: monthStart, $lte: monthEnd } }),
      Leave.find({ businessId, staffId: staff._id, status: 'approved', type: 'unpaid', from: { $lte: monthEnd }, to: { $gte: monthStart } }),
    ]);
    const unpaid = new Map<string, number>(); // date -> unpaid fraction (1 or 0.5)
    for (const a of attendance) {
      if (!employed.has(a.businessDate)) continue;
      if (a.status === 'absent') unpaid.set(a.businessDate, 1);
      else if (a.status === 'half_day') unpaid.set(a.businessDate, 0.5);
    }
    for (const lv of unpaidLeaves) {
      for (const d of datesBetween(lv.from > monthStart ? lv.from : monthStart, lv.to < monthEnd ? lv.to : monthEnd)) {
        if (employed.has(d)) unpaid.set(d, 1);
      }
    }
    const paidDays = Math.max(0, employed.size - [...unpaid.values()].reduce((a, b) => a + b, 0));
    const overtimeMin = attendance.reduce((a, r) => a + (r.overtimeMin || 0), 0);

    const baseSalaryPaise = staff.salary.type === 'monthly' ? staff.salary.amountPaise : 0;
    const salaryPaise = Math.round((baseSalaryPaise * paidDays) / totalDays);

    // 2. Commission and payroll tips
    let commissionPaise = 0;
    let tipsPaise = 0;
    for (const bill of bills) {
      for (const line of bill.lines) {
        for (const st of line.staff || []) {
          if (st.staffId?.equals(staff._id)) commissionPaise += st.commissionPaise || 0;
        }
      }
      for (const tip of bill.tips || []) {
        if (tip.staffId.equals(staff._id) && tip.payout === 'payroll') tipsPaise += tip.amountPaise;
      }
    }

    // 3. Overtime in half-hour steps
    const overtimePaise = staff.commission?.overtimePerHourPaise
      ? Math.round((Math.floor(overtimeMin / 30) * staff.commission.overtimePerHourPaise) / 2)
      : 0;

    // 4. Advances
    const openAdvances = await Advance.find({ businessId, staffId: staff._id, status: 'open' });
    const advancePaise = openAdvances.reduce(
      (a, adv) => a + Math.min(adv.amountPaise - adv.recoveredPaise, adv.recoveryPerMonthPaise),
      0
    );

    // 5. Statutory (business switch AND staff flag)
    const gross = salaryPaise + commissionPaise + overtimePaise;
    let pfPaise = 0;
    let esiPaise = 0;
    let ptPaise = 0;
    if (payroll.pf?.enabled && staff.statutory?.pf) {
      const base = Math.min(salaryPaise, payroll.pf.wageCeilingPaise || salaryPaise);
      pfPaise = Math.round((base * (payroll.pf.employeePct ?? 12)) / 100);
    }
    if (payroll.esi?.enabled && staff.statutory?.esi && gross <= (payroll.esi.wageCeilingPaise || Infinity)) {
      esiPaise = Math.round((gross * (payroll.esi.employeePct ?? 0.75)) / 100);
    }
    if (payroll.pt?.enabled && staff.statutory?.pt) {
      const slabs = [...(payroll.pt.slabs || [])].sort((a: any, b: any) => a.uptoPaise - b.uptoPaise);
      ptPaise = (slabs.find((sl: any) => gross <= sl.uptoPaise) || slabs[slabs.length - 1])?.amountPaise || 0;
    }

    lines.push({
      staffId: staff._id,
      staffName: staff.name,
      paidDays,
      salaryPaise,
      commissionPaise,
      overtimePaise,
      tipsPaise,
      incentivesPaise: 0,
      advancePaise,
      pfPaise,
      esiPaise,
      ptPaise,
      otherDeductionPaise: 0,
      netPaise: 0,
      adjustments: [],
    });
  }

  const run: any = existing || new PayrollRun({ businessId, branchId: toObjectId(branchId), month, createdBy: toObjectId(ctx.userId) });
  run.lines = lines;
  run.status = 'draft';
  run.generatedAt = new Date();
  run.updatedBy = toObjectId(ctx.userId);
  setTotals(run);
  await run.save();

  await logAction({
    businessId,
    branchId: toObjectId(branchId),
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: existing ? 'payroll.draft_regenerated' : 'payroll.draft_created',
    targetType: 'payrollRun',
    targetId: run._id,
    meta: { month, totalStaff: lines.length, netPaise: run.totals.netPaise },
  });

  return run;
}

/**
 * Manual change to one line (bonus, extra deduction, correction). Allowed on draft and reviewed
 * runs; the reason is kept on the line and in the audit log.
 */
export async function adjustPayrollLine(
  ctx: RequestContext,
  runId: string | Types.ObjectId,
  input: z.infer<typeof adjustPayrollLineSchema>
) {
  const run = await loadRun(ctx, runId);
  if (run.status === 'locked' || run.status === 'paid') {
    throw new AppError(422, ErrorCode.INVALID_TRANSITION, `A ${run.status} payroll run cannot be adjusted`);
  }

  const line: any = run.lines.find((l) => l.staffId.toString() === input.staffId.toString());
  if (!line) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Staff not found in this payroll run');
  }
  if ((line[input.field] || 0) + input.deltaPaise < 0) {
    throw new AppError(422, ErrorCode.VALIDATION_ERROR, `${input.field} cannot go below zero`, { fields: { deltaPaise: 'Too large a reduction' } });
  }

  line[input.field] = (line[input.field] || 0) + input.deltaPaise;
  line.adjustments.push({ field: input.field, deltaPaise: input.deltaPaise, reason: input.reason, by: toObjectId(ctx.userId), at: new Date() });
  setTotals(run);
  (run as any).updatedBy = toObjectId(ctx.userId);
  await run.save();

  await logAction({
    businessId: toObjectId(ctx.businessId!),
    branchId: run.branchId,
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'payroll.adjusted',
    targetType: 'payrollRun',
    targetId: run._id,
    meta: { staffId: input.staffId, field: input.field, deltaPaise: input.deltaPaise, reason: input.reason },
  });

  return run;
}

export async function reviewRun(ctx: RequestContext, runId: string | Types.ObjectId) {
  const run = await loadRun(ctx, runId);
  if (run.status !== 'draft') {
    throw new AppError(422, ErrorCode.INVALID_TRANSITION, 'Only a draft run can be marked as reviewed');
  }

  run.status = 'reviewed';
  (run as any).updatedBy = toObjectId(ctx.userId);
  await run.save();

  await logAction({
    businessId: toObjectId(ctx.businessId!),
    branchId: run.branchId,
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'payroll.reviewed',
    targetType: 'payrollRun',
    targetId: run._id,
  });

  return run;
}

/**
 * Locks a run (owner). Refused when any bill or attendance of that branch and month changed after
 * the draft was generated: regenerate first. Locking recovers the advances and freezes the month's
 * bills (they can no longer be edited or cancelled).
 */
export async function lockRun(ctx: RequestContext, runId: string | Types.ObjectId) {
  const businessId = toObjectId(ctx.businessId!);
  const userId = toObjectId(ctx.userId);

  return withTransaction(async (session) => {
    const run = await loadRun(ctx, runId, session);
    if (run.status === 'locked' || run.status === 'paid') {
      throw new AppError(422, ErrorCode.INVALID_TRANSITION, `Run is already ${run.status}`);
    }

    const since = run.generatedAt || run.createdAt;
    const monthFilter = { $gte: `${run.month}-01`, $lte: `${run.month}-31` };
    const [staleBill, staleAttendance] = await Promise.all([
      Bill.exists({ businessId, branchId: run.branchId, businessDate: monthFilter, updatedAt: { $gt: since } }).session(session),
      Attendance.exists({ businessId, branchId: run.branchId, businessDate: monthFilter, updatedAt: { $gt: since } }).session(session),
    ]);
    if (staleBill || staleAttendance) {
      throw new AppError(
        409,
        ErrorCode.PAYROLL_STALE,
        `${staleBill ? 'Bills' : 'Attendance'} changed after this draft was generated. Regenerate the draft, then lock it.`
      );
    }

    for (const line of run.lines) {
      let toRecover = line.advancePaise;
      if (toRecover <= 0) continue;
      const advances = await Advance.find({ businessId, staffId: line.staffId, status: 'open' }).sort({ date: 1 }).session(session);
      for (const adv of advances) {
        if (toRecover <= 0) break;
        const recoveredNow = Math.min(adv.amountPaise - adv.recoveredPaise, toRecover);
        adv.recoveredPaise += recoveredNow;
        toRecover -= recoveredNow;
        if (adv.recoveredPaise >= adv.amountPaise) adv.status = 'closed';
        await adv.save({ session });
      }
    }

    run.status = 'locked';
    run.lockedBy = userId;
    run.lockedAt = new Date();
    (run as any).updatedBy = userId;
    await run.save({ session });

    await logAction({
      businessId,
      branchId: run.branchId,
      actorId: userId,
      actorRole: ctx.role,
      action: 'payroll.locked',
      targetType: 'payrollRun',
      targetId: run._id,
      meta: { month: run.month, netPaise: run.totals.netPaise },
      session,
    });

    return run;
  });
}

/**
 * Records salary payment for some or all staff of a locked run; the run becomes paid when everyone is.
 */
export async function markPaid(
  ctx: RequestContext,
  runId: string | Types.ObjectId,
  input: z.infer<typeof markPayrollPaidSchema>
) {
  const run = await loadRun(ctx, runId);
  if (run.status !== 'locked') {
    throw new AppError(422, ErrorCode.INVALID_TRANSITION, run.status === 'paid' ? 'This run is already paid' : 'Lock the run before marking it paid');
  }

  const targetIds = input.staffIds?.length ? new Set(input.staffIds.map(String)) : null;
  if (targetIds && [...targetIds].some((id) => !run.lines.some((l) => l.staffId.toString() === id))) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'A staff member is not in this payroll run');
  }
  for (const line of run.lines) {
    if (!targetIds || targetIds.has(line.staffId.toString())) {
      line.paid = { mode: input.mode, date: input.date };
    }
  }
  if (run.lines.every((l) => l.paid?.date)) run.status = 'paid';

  (run as any).updatedBy = toObjectId(ctx.userId);
  await run.save();

  await logAction({
    businessId: toObjectId(ctx.businessId!),
    branchId: run.branchId,
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'payroll.marked_paid',
    targetType: 'payrollRun',
    targetId: run._id,
    meta: { mode: input.mode, date: input.date, staffIds: input.staffIds || 'all', status: run.status },
  });

  return run;
}

/** Everything a payslip shows, for one staff member of a run. */
async function payslipData(ctx: RequestContext, run: any, line: any) {
  const [business, branch, staff] = await Promise.all([
    Business.findById(run.businessId).select('name address gst'),
    Branch.findOne({ _id: run.branchId, businessId: run.businessId }).select('name address'),
    Staff.findOne({ _id: line.staffId, businessId: run.businessId }).select('name designation joiningDate bankRef phone'),
  ]);
  return {
    business: business?.toObject(),
    branch: branch?.toObject(),
    staff: staff?.toObject() || { name: line.staffName },
    month: run.month,
    daysInMonth: getDaysInMonth(run.month),
    runStatus: run.status,
    line: typeof line.toObject === 'function' ? line.toObject() : line,
  };
}

/** The payslip PDF of one staff member (generated from the run, so it always matches it). */
export async function getPayslipPdf(ctx: RequestContext, runId: string, staffId: string): Promise<{ filename: string; pdf: Buffer }> {
  const run = await loadRun(ctx, runId);
  if (run.status === 'draft') {
    throw new AppError(422, ErrorCode.INVALID_TRANSITION, 'Payslips are available once the run is reviewed');
  }
  const line = run.lines.find((l) => l.staffId.toString() === staffId);
  if (!line) throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Staff not found in this payroll run');
  const pdf = await renderPayslipPdf(await payslipData(ctx, run, line));
  return { filename: `payslip-${run.month}-${line.staffName.replace(/[^A-Za-z0-9]+/g, '-')}.pdf`, pdf };
}

/**
 * Generates and stores every payslip of a run (reviewed, locked or paid) and returns one record
 * per staff member with the download path.
 */
export async function generatePayslipsForRun(ctx: RequestContext, runId: string | Types.ObjectId) {
  const run = await loadRun(ctx, runId);
  if (run.status === 'draft') {
    throw new AppError(422, ErrorCode.INVALID_TRANSITION, 'Review the run before generating payslips');
  }

  const out = [];
  for (const line of run.lines) {
    const pdf = await renderPayslipPdf(await payslipData(ctx, run, line));
    const key = `payslips/${ctx.businessId}/${run.month}/${line.staffId}.pdf`;
    await uploadPdf(key, pdf);
    const payslip = await Payslip.findOneAndUpdate(
      { businessId: run.businessId, runId: run._id, staffId: line.staffId },
      {
        businessId: run.businessId,
        runId: run._id,
        staffId: line.staffId,
        month: run.month,
        pdfKey: key,
        createdBy: toObjectId(ctx.userId),
        updatedBy: toObjectId(ctx.userId),
      },
      { upsert: true, new: true }
    );
    out.push({
      ...payslip.toObject(),
      staffName: line.staffName,
      netPaise: line.netPaise,
      downloadPath: `/payroll-runs/${run._id}/payslips/${line.staffId}/pdf`,
    });
  }

  await logAction({
    businessId: run.businessId,
    branchId: run.branchId,
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'payroll.payslips_generated',
    targetType: 'payrollRun',
    targetId: run._id,
    meta: { count: out.length },
  });

  return out;
}

export async function getPayrollRuns(ctx: RequestContext, branchId: string | Types.ObjectId, filter: { year?: string } = {}) {
  const query: any = { businessId: toObjectId(ctx.businessId!), branchId: toObjectId(branchId) };
  if (filter.year) query.month = { $regex: `^${filter.year}-` };
  // The list shows each run's totals; open a run for its lines
  return PayrollRun.find(query).select('-lines').sort({ month: -1 });
}

export async function getPayrollRunById(ctx: RequestContext, runId: string | Types.ObjectId) {
  return loadRun(ctx, runId);
}
