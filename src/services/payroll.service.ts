import { Types } from 'mongoose';
import {
  PayrollRun,
  Payslip,
  Staff,
  Attendance,
  Bill,
  Advance,
  Business,
  withTransaction,
} from '../models';
import { AppError, ErrorCode, getDaysInMonth } from '../utils';
import { RequestContext, toObjectId } from './context';
import { logAction } from './audit.service';
import { generatePayslipPdf, uploadPdf } from '../integrations';
import { z } from 'zod';
import {
  createPayrollRunSchema,
  adjustPayrollLineSchema,
  markPayrollPaidSchema,
} from '../validations';

export async function createMonthlyRun(
  ctx: RequestContext,
  branchId: string | Types.ObjectId,
  input: z.infer<typeof createPayrollRunSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const { month } = input;
  const existing = await PayrollRun.findOne({
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(branchId),
    month,
  });

  if (existing && existing.status !== 'draft') {
    throw new AppError(
      409,
      ErrorCode.CONFLICT,
      `Payroll run for ${month} is already ${existing.status}`
    );
  }

  const [yearStr, monthStr] = month.split('-');
  const year = parseInt(yearStr, 10);
  const monthNum = parseInt(monthStr, 10);
  const totalDays = getDaysInMonth(year, monthNum);

  const startDateStr = `${month}-01`;
  const endDateStr = `${month}-${String(totalDays).padStart(2, '0')}`;

  const staffList = await Staff.find({
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(branchId),
    status: 'active',
  });

  const business = await Business.findById(toObjectId(ctx.businessId));

  const lines: any[] = [];
  let totalNetPaise = 0;

  for (const staff of staffList) {
    // 1. Calculate paid days from attendance
    const attendanceRecords = await Attendance.find({
      businessId: toObjectId(ctx.businessId),
      branchId: toObjectId(branchId),
      staffId: staff._id,
      businessDate: { $gte: startDateStr, $lte: endDateStr },
    });

    let paidDays = 0;
    let overtimeMin = 0;

    for (const att of attendanceRecords) {
      if (att.status === 'present' || att.status === 'late' || att.status === 'leave' || att.status === 'week_off' || att.status === 'holiday') {
        paidDays += 1;
      } else if (att.status === 'half_day') {
        paidDays += 0.5;
      }
      overtimeMin += att.overtimeMin || 0;
    }

    if (attendanceRecords.length === 0) {
      paidDays = totalDays;
    }

    const baseSalaryPaise = staff.salary.type === 'monthly' ? staff.salary.amountPaise : 0;
    const salaryPaise = Math.round((baseSalaryPaise * paidDays) / totalDays);

    // 2. Commission & tips from bills
    const bills = await Bill.find({
      businessId: toObjectId(ctx.businessId),
      branchId: toObjectId(branchId),
      businessDate: { $gte: startDateStr, $lte: endDateStr },
      status: { $in: ['paid', 'partly_paid'] },
    });

    let commissionPaise = 0;
    let tipsPaise = 0;

    for (const bill of bills) {
      for (const line of bill.lines) {
        for (const stf of line.staff || []) {
          if (stf.staffId && stf.staffId.toString() === staff._id.toString()) {
            commissionPaise += stf.commissionPaise || 0;
          }
        }
      }
      for (const tip of bill.tips || []) {
        if (tip.staffId.toString() === staff._id.toString() && tip.payout === 'payroll') {
          tipsPaise += tip.amountPaise;
        }
      }
    }

    // 3. Overtime
    let overtimePaise = 0;
    if (staff.commission?.overtimePerHourPaise && overtimeMin > 0) {
      const halfHours = Math.floor(overtimeMin / 30);
      overtimePaise = Math.round((halfHours * staff.commission.overtimePerHourPaise) / 2);
    }

    // 4. Advances recovery
    const openAdvances = await Advance.find({
      businessId: toObjectId(ctx.businessId),
      staffId: staff._id,
      status: 'open',
    });

    let advanceDeductionPaise = 0;
    for (const adv of openAdvances) {
      const remaining = adv.amountPaise - adv.recoveredPaise;
      const toRecover = Math.min(remaining, adv.recoveryPerMonthPaise);
      advanceDeductionPaise += toRecover;
    }

    // 5. Statutory
    let pfPaise = 0;
    let esiPaise = 0;
    let ptPaise = 0;

    if (business?.payroll?.pf?.enabled && staff.statutory?.pf && salaryPaise > 0) {
      const ceiling = business.payroll.pf.wageCeilingPaise ?? 1500000;
      const pct = business.payroll.pf.employeePct ?? 12;
      const eligibleSalary = Math.min(salaryPaise, ceiling);
      pfPaise = Math.round((eligibleSalary * pct) / 100);
    }
    if (business?.payroll?.esi?.enabled && staff.statutory?.esi && salaryPaise > 0) {
      const ceiling = business.payroll.esi.wageCeilingPaise ?? 2100000;
      const pct = business.payroll.esi.employeePct ?? 0.75;
      if (salaryPaise <= ceiling) {
        esiPaise = Math.round((salaryPaise * pct) / 100);
      }
    }
    if (business?.payroll?.pt?.enabled && staff.statutory?.pt && salaryPaise > 0) {
      const slabs = business.payroll.pt.slabs || [];
      let matched = false;
      for (const slab of slabs) {
        if (slab.uptoPaise && salaryPaise <= slab.uptoPaise) {
          ptPaise = slab.amountPaise;
          matched = true;
          break;
        }
      }
      if (!matched && slabs.length > 0) {
        ptPaise = slabs[slabs.length - 1].amountPaise;
      } else if (slabs.length === 0 && salaryPaise > 1000000) {
        ptPaise = 20000;
      }
    }

    const netPaise = Math.max(
      0,
      salaryPaise +
        commissionPaise +
        overtimePaise +
        tipsPaise -
        advanceDeductionPaise -
        pfPaise -
        esiPaise -
        ptPaise
    );

    totalNetPaise += netPaise;

    lines.push({
      staffId: staff._id,
      staffName: staff.name,
      paidDays,
      salaryPaise,
      commissionPaise,
      overtimePaise,
      tipsPaise,
      incentivesPaise: 0,
      advancePaise: advanceDeductionPaise,
      pfPaise,
      esiPaise,
      ptPaise,
      otherDeductionPaise: 0,
      netPaise,
      adjustments: [],
    });
  }

  const now = new Date();
  let run: any;
  if (existing) {
    existing.lines = lines;
    existing.totals = { netPaise: totalNetPaise };
    existing.draftedAt = now;
    (existing as any).updatedBy = toObjectId(ctx.userId);
    run = await existing.save();
  } else {
    run = await PayrollRun.create({
      businessId: toObjectId(ctx.businessId),
      branchId: toObjectId(branchId),
      month,
      status: 'draft',
      draftedAt: now,
      lines,
      totals: { netPaise: totalNetPaise },
      createdBy: toObjectId(ctx.userId),
      updatedBy: toObjectId(ctx.userId),
    });
  }

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(branchId),
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'payroll.draft_created',
    targetType: 'payrollRun',
    targetId: run._id,
    meta: { month, totalStaff: lines.length, totalNetPaise },
  });

  return run;
}

export async function adjustPayrollLine(
  ctx: RequestContext,
  runId: string | Types.ObjectId,
  input: z.infer<typeof adjustPayrollLineSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const run = await PayrollRun.findOne({ _id: toObjectId(runId), businessId: toObjectId(ctx.businessId) });
  if (!run) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Payroll run not found');
  }

  if (run.status === 'locked' || run.status === 'paid') {
    throw new AppError(400, ErrorCode.BAD_REQUEST, `Cannot adjust ${run.status} payroll run`);
  }

  const lineIndex = run.lines.findIndex((l) => l.staffId.toString() === input.staffId.toString());
  if (lineIndex === -1) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Staff not found in this payroll run');
  }

  const line = run.lines[lineIndex];
  const field = input.field as keyof typeof line;

  if (typeof (line as any)[field] !== 'number' && field !== 'otherDeductionPaise') {
    throw new AppError(400, ErrorCode.BAD_REQUEST, `Field ${input.field} cannot be adjusted as an amount`);
  }

  (line as any)[field] = ((line as any)[field] || 0) + input.deltaPaise;

  line.adjustments.push({
    field: input.field,
    deltaPaise: input.deltaPaise,
    reason: input.reason,
    by: toObjectId(ctx.userId),
    at: new Date(),
  });

  line.netPaise = Math.max(
    0,
    line.salaryPaise +
      line.commissionPaise +
      line.overtimePaise +
      line.tipsPaise +
      line.incentivesPaise -
      line.advancePaise -
      line.pfPaise -
      line.esiPaise -
      line.ptPaise -
      line.otherDeductionPaise
  );

  let totalNet = 0;
  for (const l of run.lines) {
    totalNet += l.netPaise;
  }
  run.totals.netPaise = totalNet;
  (run as any).updatedBy = toObjectId(ctx.userId);

  await run.save();

  await logAction({
    businessId: toObjectId(ctx.businessId),
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

export async function reviewRun(
  ctx: RequestContext,
  runId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const run = await PayrollRun.findOne({ _id: toObjectId(runId), businessId: toObjectId(ctx.businessId) });
  if (!run) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Payroll run not found');
  }

  if (run.status !== 'draft') {
    throw new AppError(400, ErrorCode.BAD_REQUEST, 'Only draft runs can be marked as reviewed');
  }

  run.status = 'reviewed';
  (run as any).updatedBy = toObjectId(ctx.userId);
  await run.save();

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: run.branchId,
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'payroll.reviewed',
    targetType: 'payrollRun',
    targetId: run._id,
  });

  return run;
}

export async function lockRun(
  ctx: RequestContext,
  runId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }
  const businessId = toObjectId(ctx.businessId);
  const userId = toObjectId(ctx.userId);

  return withTransaction(async (session) => {
    const run = await PayrollRun.findOne({ _id: toObjectId(runId), businessId }).session(session);
    if (!run) {
      throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Payroll run not found');
    }

    if (run.status === 'locked' || run.status === 'paid') {
      throw new AppError(400, ErrorCode.BAD_REQUEST, `Run is already ${run.status}`);
    }

    const runDraftedAt = run.draftedAt || (run as any).updatedAt || run.createdAt;
    const staleBill = await Bill.findOne({
      businessId,
      branchId: run.branchId,
      updatedAt: { $gt: runDraftedAt },
      businessDate: { $regex: `^${run.month}` },
    }).session(session);

    if (staleBill) {
      throw new AppError(
        409,
        ErrorCode.PAYROLL_STALE,
        'Bills have changed since this payroll draft was generated. Please regenerate the draft.'
      );
    }

    for (const line of run.lines) {
      if (line.advancePaise > 0) {
        let toRecover = line.advancePaise;
        const advances = await Advance.find({
          businessId,
          staffId: line.staffId,
          status: 'open',
        }).session(session);

        for (const adv of advances) {
          if (toRecover <= 0) break;
          const remaining = adv.amountPaise - adv.recoveredPaise;
          const recoveredNow = Math.min(remaining, toRecover);
          adv.recoveredPaise += recoveredNow;
          toRecover -= recoveredNow;

          if (adv.recoveredPaise >= adv.amountPaise) {
            adv.status = 'closed';
          }
          await adv.save({ session });
        }
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
    });

    return run;
  });
}

export async function markPaid(
  ctx: RequestContext,
  runId: string | Types.ObjectId,
  input: z.infer<typeof markPayrollPaidSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const run = await PayrollRun.findOne({ _id: toObjectId(runId), businessId: toObjectId(ctx.businessId) });
  if (!run) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Payroll run not found');
  }

  if (run.status !== 'locked' && run.status !== 'reviewed') {
    throw new AppError(400, ErrorCode.BAD_REQUEST, 'Run must be locked before marking paid');
  }

  const targetIds = input.staffIds && input.staffIds.length > 0
    ? new Set(input.staffIds.map((id) => id.toString()))
    : null;

  let allPaid = true;

  for (const line of run.lines) {
    if (!targetIds || targetIds.has(line.staffId.toString())) {
      line.paid = {
        mode: input.mode,
        date: input.date,
      };
    }
    if (!line.paid) {
      allPaid = false;
    }
  }

  if (allPaid) {
    run.status = 'paid';
  }

  (run as any).updatedBy = toObjectId(ctx.userId);
  await run.save();

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: run.branchId,
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'payroll.marked_paid',
    targetType: 'payrollRun',
    targetId: run._id,
    meta: { mode: input.mode, date: input.date, allPaid },
  });

  return run;
}

export async function generatePayslipsForRun(
  ctx: RequestContext,
  runId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const run = await PayrollRun.findOne({ _id: toObjectId(runId), businessId: toObjectId(ctx.businessId) });
  if (!run) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Payroll run not found');
  }

  const createdPayslips = [];

  for (const line of run.lines) {
    const pdfBuffer = await generatePayslipPdf({
      month: run.month,
      staffName: line.staffName,
      paidDays: line.paidDays,
      salaryPaise: line.salaryPaise,
      commissionPaise: line.commissionPaise,
      overtimePaise: line.overtimePaise,
      tipsPaise: line.tipsPaise,
      incentivesPaise: line.incentivesPaise,
      advancePaise: line.advancePaise,
      pfPaise: line.pfPaise,
      esiPaise: line.esiPaise,
      ptPaise: line.ptPaise,
      otherDeductionPaise: line.otherDeductionPaise,
      netPaise: line.netPaise,
    });

    const key = `payslips/${ctx.businessId}/${run.month}/${line.staffId}.pdf`;
    await uploadPdf(key, pdfBuffer);

    const payslip = await Payslip.findOneAndUpdate(
      {
        businessId: toObjectId(ctx.businessId),
        runId: run._id,
        staffId: line.staffId,
      },
      {
        businessId: toObjectId(ctx.businessId),
        runId: run._id,
        staffId: line.staffId,
        month: run.month,
        pdfKey: key,
        createdBy: toObjectId(ctx.userId),
        updatedBy: toObjectId(ctx.userId),
      },
      { upsert: true, new: true }
    );

    createdPayslips.push(payslip);
  }

  return createdPayslips;
}

export async function getPayrollRuns(
  ctx: RequestContext,
  branchId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  return PayrollRun.find({ businessId: toObjectId(ctx.businessId), branchId: toObjectId(branchId) }).sort({ month: -1 });
}

export async function getPayrollRunById(
  ctx: RequestContext,
  runId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const run = await PayrollRun.findOne({ _id: toObjectId(runId), businessId: toObjectId(ctx.businessId) });
  if (!run) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Payroll run not found');
  }
  return run;
}
