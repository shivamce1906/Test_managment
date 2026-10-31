import { Types } from 'mongoose';
import { Staff, Roster, Attendance, Leave, Advance, Expense, Branch, Service, withTransaction } from '../models';
import { AppError, ErrorCode, getBusinessDate, getIstDayOfWeek, normalizePhone, parseIstDateTime } from '../utils';
import { RequestContext, toObjectId } from './context';
import { logAction } from './audit.service';
import { assertRefsInBusiness } from './tenant-refs';
import { z } from 'zod';
import {
  createStaffSchema,
  updateStaffSchema,
  updateRosterSchema,
  markAttendanceSchema,
  createLeaveSchema,
  updateLeaveStatusSchema,
  createAdvanceSchema,
} from '../validations';

export async function createStaff(
  ctx: RequestContext,
  input: z.infer<typeof createStaffSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  if (ctx.role === 'manager' && !ctx.branchIds.includes(input.branchId)) {
    throw new AppError(403, ErrorCode.FORBIDDEN, 'Cannot add staff to a branch you do not manage');
  }
  await assertRefsInBusiness(Branch, ctx.businessId, [input.branchId], 'branches');
  await assertRefsInBusiness(Service, ctx.businessId, input.serviceIds, 'services');

  const phone = normalizePhone(input.phone);

  const staff = await Staff.create({
    businessId: toObjectId(ctx.businessId),
    ...input,
    branchId: toObjectId(input.branchId),
    serviceIds: input.serviceIds.map(toObjectId),
    phone,
    createdBy: toObjectId(ctx.userId),
    updatedBy: toObjectId(ctx.userId),
  });

  const defaultWeekly = [
    { day: 0, start: '10:00', end: '20:00', off: false },
    { day: 1, start: '10:00', end: '20:00', off: false },
    { day: 2, start: '10:00', end: '20:00', off: false },
    { day: 3, start: '10:00', end: '20:00', off: false },
    { day: 4, start: '10:00', end: '20:00', off: false },
    { day: 5, start: '10:00', end: '20:00', off: false },
    { day: 6, start: '10:00', end: '20:00', off: false },
  ];

  await Roster.create({
    businessId: toObjectId(ctx.businessId),
    branchId: staff.branchId,
    staffId: staff._id,
    weekly: defaultWeekly,
    overrides: [],
    createdBy: toObjectId(ctx.userId),
    updatedBy: toObjectId(ctx.userId),
  });

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: staff.branchId,
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'staff.created',
    targetType: 'staff',
    targetId: staff._id,
    after: staff.toObject(),
  });

  return staff;
}

export async function updateStaff(
  ctx: RequestContext,
  staffId: string | Types.ObjectId,
  input: z.infer<typeof updateStaffSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const staff = await Staff.findOne({ _id: toObjectId(staffId), businessId: toObjectId(ctx.businessId) });
  if (!staff) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Staff member not found');
  }

  const before = staff.toObject();

  if (input.branchId) {
    if (ctx.role === 'manager' && !ctx.branchIds.includes(input.branchId)) {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'Cannot move staff to a branch you do not manage');
    }
    await assertRefsInBusiness(Branch, ctx.businessId, [input.branchId], 'branches');
  }
  await assertRefsInBusiness(Service, ctx.businessId, input.serviceIds, 'services');
  const movedBranch = !!input.branchId && input.branchId !== staff.branchId.toString();

  if (input.phone) {
    staff.phone = normalizePhone(input.phone);
  }
  if (input.name) staff.name = input.name;
  if (input.designation) staff.designation = input.designation;
  if (input.branchId) staff.branchId = toObjectId(input.branchId);
  if (input.serviceIds) staff.serviceIds = input.serviceIds.map(toObjectId);
  if (input.salary) staff.salary = input.salary;
  if (input.commission) staff.commission = input.commission as any;
  if (input.statutory) staff.statutory = input.statutory;
  if (input.bankRef) staff.bankRef = input.bankRef;
  if (input.documents) staff.documents = input.documents;
  if (input.emergencyContact) staff.emergencyContact = input.emergencyContact;
  if (input.status) staff.status = input.status;
  if (input.exitDate) staff.exitDate = input.exitDate;
  if (input.exitReason) staff.exitReason = input.exitReason;

  (staff as any).updatedBy = toObjectId(ctx.userId);
  await staff.save();

  // The roster follows the staff member to the new branch
  if (movedBranch) {
    await Roster.updateOne(
      { businessId: staff.businessId, staffId: staff._id },
      { $set: { branchId: staff.branchId } }
    );
  }

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: staff.branchId,
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'staff.updated',
    targetType: 'staff',
    targetId: staff._id,
    before,
    after: staff.toObject(),
  });

  return staff;
}

export async function getStaffList(
  ctx: RequestContext,
  filter?: { branchId?: string | Types.ObjectId; status?: 'active' | 'exited'; designation?: string; q?: string }
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const query: any = { businessId: toObjectId(ctx.businessId) };
  if (filter?.branchId) query.branchId = toObjectId(filter.branchId);
  if (filter?.status) query.status = filter.status;
  if (filter?.designation) query.designation = filter.designation;
  if (filter?.q) {
    const text = filter.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.$or = [{ name: { $regex: text, $options: 'i' } }, { phone: { $regex: text.replace(/\D/g, '') || text } }];
  }

  return Staff.find(query).sort({ name: 1 });
}

export async function getStaffById(
  ctx: RequestContext,
  staffId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const staff = await Staff.findOne({ _id: toObjectId(staffId), businessId: toObjectId(ctx.businessId) });
  if (!staff) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Staff member not found');
  }
  return staff;
}

export async function getBilledByStaff(
  ctx: RequestContext,
  branchId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  return Staff.find({
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(branchId),
    status: 'active',
    designation: 'receptionist',
  })
    .select('_id name designation phone')
    .sort({ name: 1 });
}

// ----------------------------------------------------
// Rosters
// ----------------------------------------------------

export async function getRoster(
  ctx: RequestContext,
  staffId: string | Types.ObjectId
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  let roster = await Roster.findOne({ businessId: toObjectId(ctx.businessId), staffId: toObjectId(staffId) });
  if (!roster) {
    const staff = await Staff.findOne({ _id: toObjectId(staffId), businessId: toObjectId(ctx.businessId) });
    if (!staff) {
      throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Staff member not found');
    }
    const defaultWeekly = [
      { day: 0, start: '10:00', end: '20:00', off: false },
      { day: 1, start: '10:00', end: '20:00', off: false },
      { day: 2, start: '10:00', end: '20:00', off: false },
      { day: 3, start: '10:00', end: '20:00', off: false },
      { day: 4, start: '10:00', end: '20:00', off: false },
      { day: 5, start: '10:00', end: '20:00', off: false },
      { day: 6, start: '10:00', end: '20:00', off: false },
    ];
    roster = await Roster.create({
      businessId: toObjectId(ctx.businessId),
      branchId: staff.branchId,
      staffId: staff._id,
      weekly: defaultWeekly,
      overrides: [],
      createdBy: toObjectId(ctx.userId),
      updatedBy: toObjectId(ctx.userId),
    });
  }

  return roster;
}

export async function updateRoster(
  ctx: RequestContext,
  staffId: string | Types.ObjectId,
  input: z.infer<typeof updateRosterSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const staff = await Staff.findOne({ _id: toObjectId(staffId), businessId: toObjectId(ctx.businessId) });
  if (!staff) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Staff member not found');
  }

  let roster = await Roster.findOne({ businessId: toObjectId(ctx.businessId), staffId: toObjectId(staffId) });
  const before = roster ? roster.toObject() : null;

  if (!roster) {
    roster = new Roster({
      businessId: toObjectId(ctx.businessId),
      branchId: staff.branchId,
      staffId: staff._id,
      weekly: input.weekly,
      overrides: input.overrides,
      createdBy: toObjectId(ctx.userId),
      updatedBy: toObjectId(ctx.userId),
    });
  } else {
    roster.weekly = input.weekly;
    roster.overrides = input.overrides;
    (roster as any).updatedBy = toObjectId(ctx.userId);
  }

  await roster.save();

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: staff.branchId,
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'roster.updated',
    targetType: 'roster',
    targetId: roster._id,
    before: before || undefined,
    after: roster.toObject(),
  });

  return roster;
}

// ----------------------------------------------------
// Attendance
// ----------------------------------------------------

export async function getAttendance(
  ctx: RequestContext,
  branchId: string | Types.ObjectId,
  businessDate: string
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const staffList = await Staff.find({
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(branchId),
    status: 'active',
  });

  const records = await Attendance.find({
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(branchId),
    businessDate,
  });

  const recordMap = new Map(records.map((r) => [r.staffId.toString(), r]));

  return staffList.map((staff) => {
    return {
      staff,
      attendance: recordMap.get(staff._id.toString()) || null,
    };
  });
}

export async function markAttendance(
  ctx: RequestContext,
  branchId: string | Types.ObjectId,
  businessDate: string,
  input: z.infer<typeof markAttendanceSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const today = getBusinessDate();
  const isPast = businessDate < today;

  if (isPast && !input.reason) {
    throw new AppError(
      400,
      ErrorCode.BAD_REQUEST,
      'A reason is mandatory when modifying attendance records for past dates'
    );
  }

  const staffIds = [...new Set(input.entries.map((e) => e.staffId))];
  const branchStaff = await Staff.countDocuments({
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(branchId),
    _id: { $in: staffIds.map(toObjectId) },
  });
  if (branchStaff !== staffIds.length) {
    throw new AppError(404, ErrorCode.NOT_FOUND, 'One or more staff members are not in this branch');
  }
  for (const entry of input.entries) {
    if (entry.inAt && entry.outAt && new Date(entry.outAt) <= new Date(entry.inAt)) {
      throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'Clock-out must be after clock-in', {
        fields: { outAt: 'Clock-out must be after clock-in' },
      });
    }
  }

  const rosters = await Roster.find({ businessId: toObjectId(ctx.businessId), staffId: { $in: staffIds.map(toObjectId) } });
  const rosterByStaff = new Map(rosters.map((r) => [r.staffId.toString(), r]));
  const dayOfWeek = getIstDayOfWeek(parseIstDateTime(businessDate, '12:00'));

  const results = [];

  for (const entry of input.entries) {
    let record = await Attendance.findOne({
      businessId: toObjectId(ctx.businessId),
      staffId: toObjectId(entry.staffId),
      businessDate,
    });

    const status = entry.status || 'present';
    const inAt = entry.inAt ? new Date(entry.inAt) : undefined;
    const outAt = entry.outAt ? new Date(entry.outAt) : undefined;

    let overtimeMin = 0;
    if (inAt && outAt) {
      const workedMin = Math.round((outAt.getTime() - inAt.getTime()) / 60000);
      const shiftMin = rosteredShiftMinutes(rosterByStaff.get(entry.staffId), businessDate, dayOfWeek);
      overtimeMin = Math.max(0, workedMin - shiftMin);
    }

    if (!record) {
      record = await Attendance.create({
        businessId: toObjectId(ctx.businessId),
        branchId: toObjectId(branchId),
        staffId: toObjectId(entry.staffId),
        businessDate,
        status,
        inAt,
        outAt,
        overtimeMin,
        note: entry.note,
        markedBy: toObjectId(ctx.userId),
        edits: isPast
          ? [
              {
                by: toObjectId(ctx.userId),
                at: new Date(),
                reason: input.reason || 'Initial past date entry',
                before: {},
              },
            ]
          : [],
        createdBy: toObjectId(ctx.userId),
        updatedBy: toObjectId(ctx.userId),
      });
    } else {
      const before = record.toObject();
      if (isPast || input.reason) {
        record.edits.push({
          by: toObjectId(ctx.userId),
          at: new Date(),
          reason: input.reason || 'Attendance modified',
          before,
        });
      }
      record.status = status;
      if (inAt) record.inAt = inAt;
      if (outAt) record.outAt = outAt;
      if (overtimeMin > 0) record.overtimeMin = overtimeMin;
      if (entry.note !== undefined) record.note = entry.note;
      (record as any).updatedBy = toObjectId(ctx.userId);
      await record.save();
    }

    results.push(record);
  }

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(branchId),
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'attendance.marked',
    targetType: 'branch',
    targetId: toObjectId(branchId),
    meta: { businessDate, count: results.length, reason: input.reason },
  });

  return results;
}

/** Minutes the staff member is rostered for on a date (override first, then weekly); 9 h without a roster. */
function rosteredShiftMinutes(roster: any, businessDate: string, dayOfWeek: number): number {
  if (!roster) return 9 * 60;
  const slot =
    (roster.overrides || []).find((o: any) => o.date === businessDate) ||
    (roster.weekly || []).find((d: any) => d.day === dayOfWeek);
  if (!slot) return 9 * 60;
  if (slot.off || !slot.start || !slot.end) return 0;
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return Math.max(0, toMin(slot.end) - toMin(slot.start));
}

// ----------------------------------------------------
// Leaves
// ----------------------------------------------------

export async function createLeave(
  ctx: RequestContext,
  branchId: string,
  input: z.infer<typeof createLeaveSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const staff = await Staff.findOne({
    _id: toObjectId(input.staffId),
    businessId: toObjectId(ctx.businessId),
    branchId: toObjectId(branchId),
  });
  if (!staff) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Staff member not found in this branch');
  }

  const leave = await Leave.create({
    businessId: toObjectId(ctx.businessId),
    branchId: staff.branchId,
    staffId: staff._id,
    from: input.from,
    to: input.to,
    type: input.type,
    status: 'approved',
    reason: input.reason,
    createdBy: toObjectId(ctx.userId),
    updatedBy: toObjectId(ctx.userId),
  });

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: staff.branchId,
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'leave.created',
    targetType: 'leave',
    targetId: leave._id,
    after: leave.toObject(),
  });

  return leave;
}

export async function updateLeaveStatus(
  ctx: RequestContext,
  leaveId: string | Types.ObjectId,
  input: z.infer<typeof updateLeaveStatusSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const leave = await Leave.findOne({ _id: toObjectId(leaveId), businessId: toObjectId(ctx.businessId) });
  if (!leave) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Leave request not found');
  }

  const before = leave.toObject();
  leave.status = input.status;
  (leave as any).updatedBy = toObjectId(ctx.userId);
  await leave.save();

  await logAction({
    businessId: toObjectId(ctx.businessId),
    branchId: leave.branchId,
    actorId: toObjectId(ctx.userId),
    actorRole: ctx.role,
    action: 'leave.status_updated',
    targetType: 'leave',
    targetId: leave._id,
    before,
    after: leave.toObject(),
  });

  return leave;
}

export async function getLeaves(
  ctx: RequestContext,
  branchId: string | Types.ObjectId,
  filter?: { staffId?: string | Types.ObjectId; status?: string }
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const query: any = { businessId: toObjectId(ctx.businessId), branchId: toObjectId(branchId) };
  if (filter?.staffId) query.staffId = toObjectId(filter.staffId);
  if (filter?.status) query.status = filter.status;

  return Leave.find(query).populate('staffId', 'name phone designation').sort({ from: -1 });
}

// ----------------------------------------------------
// Advances
// ----------------------------------------------------

export async function createAdvance(
  ctx: RequestContext,
  branchId: string,
  input: z.infer<typeof createAdvanceSchema>
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const businessId = toObjectId(ctx.businessId);
  const userId = toObjectId(ctx.userId);

  const staff = await Staff.findOne({ _id: toObjectId(input.staffId), businessId, branchId: toObjectId(branchId) });
  if (!staff) {
    throw new AppError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Staff member not found in this branch');
  }

  return withTransaction(async (session) => {
    let expenseId: Types.ObjectId | undefined;

    if (input.payFromTill) {
      const expense = await Expense.create(
        [
          {
            businessId,
            branchId: staff.branchId,
            businessDate: input.date,
            category: 'salary_advance',
            amountPaise: input.amountPaise,
            mode: 'cash',
            paidFrom: 'till',
            note: `Salary advance for ${staff.name}`,
            createdBy: userId,
            updatedBy: userId,
          },
        ],
        { session }
      );
      expenseId = expense[0]._id;
    }

    const advance = await Advance.create(
      [
        {
          businessId,
          branchId: staff.branchId,
          staffId: staff._id,
          amountPaise: input.amountPaise,
          date: input.date,
          recoveryPerMonthPaise: input.recoveryPerMonthPaise,
          recoveredPaise: 0,
          expenseId,
          status: 'open',
          createdBy: userId,
          updatedBy: userId,
        },
      ],
      { session }
    );

    await logAction({
      businessId,
      branchId: staff.branchId,
      actorId: userId,
      actorRole: ctx.role,
      action: 'advance.created',
      targetType: 'advance',
      targetId: advance[0]._id,
      after: advance[0].toObject(),
    });

    return advance[0];
  });
}

export async function getAdvances(
  ctx: RequestContext,
  filter?: { branchId?: string | Types.ObjectId; staffId?: string | Types.ObjectId; status?: 'open' | 'closed' }
) {
  if (!ctx.businessId) {
    throw new AppError(400, ErrorCode.TENANT_SCOPE_MISSING, 'Business context missing');
  }

  const query: any = { businessId: toObjectId(ctx.businessId) };
  if (filter?.branchId) query.branchId = toObjectId(filter.branchId);
  if (filter?.staffId) query.staffId = toObjectId(filter.staffId);
  if (filter?.status) query.status = filter.status;

  return Advance.find(query).populate('staffId', 'name phone designation').sort({ date: -1 });
}
