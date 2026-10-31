import { ClientSession, Types } from 'mongoose';
import {
  Appointment,
  StaffBlock,
  Staff,
  Service,
  Branch,
  Leave,
  Roster,
  Customer,
  Counter,
  withTransaction,
  IAppointment,
} from '../models';
import {
  AppError,
  getBusinessDate,
  getIstDayOfWeek,
  formatIstTime,
  parseIstDateTime,
  isOverlapping,
  normalizePhone,
  maskPhone,
} from '../utils';
import { RequestContext, toObjectId } from './context';
import { auditService } from './audit.service';
// import { notificationService } from './notification.service'

// 'billed' is never set by hand: saving a bill with appointmentId moves the appointment there
const VALID_TRANSITIONS: Record<string, string[]> = {
  booked: ['confirmed', 'arrived', 'cancelled', 'no_show'],
  confirmed: ['arrived', 'in_service', 'cancelled', 'no_show'],
  arrived: ['in_service', 'cancelled'],
  in_service: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
  billed: [],
};

/** Designations that never take service bookings ("any available" skips them). */
const NON_SERVICE_DESIGNATIONS = ['receptionist', 'manager'];

/** Statuses that no longer hold a slot. */
const FREED_STATUSES = ['cancelled', 'no_show'];

const overlaps = (a: { start: Date; end: Date }, b: { start: Date; end: Date }) => a.start < b.end && b.start < a.end;

/** Managers and branch logins only see their own branches' appointments. */
function assertBranchScope(ctx: RequestContext, branchId: Types.ObjectId): void {
  if ((ctx.role === 'manager' || ctx.role === 'branch') && !ctx.branchIds.includes(branchId.toString())) {
    throw new AppError(404, 'NOT_FOUND', 'Appointment not found');
  }
}

function presentCustomer(ctx: RequestContext, apt: any): any {
  const obj: any = typeof apt.toObject === 'function' ? apt.toObject() : apt;
  if (obj.customerId && typeof obj.customerId === 'object' && obj.customerId.phone && (ctx.role === 'manager' || ctx.role === 'branch')) {
    obj.customerId = { ...obj.customerId, phone: maskPhone(obj.customerId.phone) };
  }
  return obj;
}

export class AppointmentService {
  /**
   * Checks for clash against branch hours, holidays, roster, leave, appointments, and staff blocks.
   */
  async checkSlotClash(
    businessId: Types.ObjectId,
    branchId: Types.ObjectId,
    staffId: Types.ObjectId,
    serviceId: Types.ObjectId,
    start: Date,
    end: Date,
    excludeAppointmentId?: Types.ObjectId,
    session?: ClientSession
  ): Promise<void> {
    const businessDate = getBusinessDate(start);

    // 1. Check branch hours and holidays
    const branch = await Branch.findOne({ _id: branchId, businessId }).session(session || null);
    if (!branch) {
      throw new AppError(404, 'NOT_FOUND', 'Branch not found');
    }

    // Holiday check
    const isHoliday = branch.holidays.some((h) => h.date === businessDate);
    if (isHoliday) {
      throw new AppError(409, 'SLOT_CLASH', `Branch is closed for holiday on ${businessDate}`);
    }

    // Working hours check
    const dayOfWeek = getIstDayOfWeek(start);
    const dayHours = branch.hours.find((h) => h.day === dayOfWeek);
    if (!dayHours || dayHours.closed || !dayHours.open || !dayHours.close) {
      throw new AppError(409, 'SLOT_CLASH', `Branch is closed on this day of week`);
    }

    const branchOpenDate = parseIstDateTime(businessDate, dayHours.open);
    const branchCloseDate = parseIstDateTime(businessDate, dayHours.close);

    if (start < branchOpenDate || end > branchCloseDate) {
      throw new AppError(
        409,
        'SLOT_CLASH',
        `Appointment (${formatIstTime(start)} - ${formatIstTime(end)}) is outside branch hours (${dayHours.open} - ${dayHours.close})`
      );
    }

    // 2. Staff check
    const staff = await Staff.findOne({ _id: staffId, businessId, branchId, status: 'active' }).session(session || null);
    if (!staff) {
      throw new AppError(404, 'NOT_FOUND', 'Staff member not found or inactive');
    }

    // Service eligibility check
    const service = await Service.findOne({ _id: serviceId, businessId, active: true }).session(session || null);
    if (!service) {
      throw new AppError(404, 'NOT_FOUND', 'Service not found or inactive');
    }

    // Eligible when both lists allow it (an empty list means "no restriction")
    const allowedByService = service.eligibleStaffIds.length === 0 || service.eligibleStaffIds.some((id) => id.equals(staffId));
    const allowedByStaff = staff.serviceIds.length === 0 || staff.serviceIds.some((id) => id.equals(serviceId));
    if (!allowedByService || !allowedByStaff) {
      throw new AppError(409, 'SLOT_CLASH', `Staff member ${staff.name} is not eligible for service ${service.name}`);
    }

    // 3. Check staff leave
    const leave = await Leave.findOne({
      businessId,
      branchId,
      staffId,
      status: 'approved',
      from: { $lte: businessDate },
      to: { $gte: businessDate },
    }).session(session || null);

    if (leave) {
      throw new AppError(409, 'SLOT_CLASH', `Staff ${staff.name} is on approved leave on ${businessDate}`);
    }

    // 4. Check staff roster
    const roster = await Roster.findOne({ businessId, branchId, staffId }).session(session || null);
    if (roster) {
      const override = roster.overrides.find((o) => o.date === businessDate);
      if (override) {
        if (override.off) {
          throw new AppError(409, 'SLOT_CLASH', `Staff ${staff.name} is rostered off on ${businessDate}`);
        }
        if (override.start && override.end) {
          const rStart = parseIstDateTime(businessDate, override.start);
          const rEnd = parseIstDateTime(businessDate, override.end);
          if (start < rStart || end > rEnd) {
            throw new AppError(409, 'SLOT_CLASH', `Appointment is outside staff ${staff.name}'s shift (${override.start} - ${override.end})`);
          }
        }
      } else {
        const weekly = roster.weekly.find((w) => w.day === dayOfWeek);
        if (weekly) {
          if (weekly.off) {
            throw new AppError(409, 'SLOT_CLASH', `Staff ${staff.name} has a scheduled off on this day`);
          }
          if (weekly.start && weekly.end) {
            const rStart = parseIstDateTime(businessDate, weekly.start);
            const rEnd = parseIstDateTime(businessDate, weekly.end);
            if (start < rStart || end > rEnd) {
              throw new AppError(409, 'SLOT_CLASH', `Appointment is outside staff ${staff.name}'s shift (${weekly.start} - ${weekly.end})`);
            }
          }
        }
      }
    }

    // 5. Check staff blocks
    const block = await StaffBlock.findOne({
      businessId,
      staffId,
      start: { $lt: end },
      end: { $gt: start },
    }).session(session || null);

    if (block) {
      throw new AppError(409, 'SLOT_CLASH', `Staff ${staff.name} is blocked for "${block.reason}"`);
    }

    // 6. Check existing appointments: a clash is one of THIS staff member's lines overlapping
    const aptQuery: any = {
      businessId,
      branchId,
      status: { $nin: FREED_STATUSES },
      lines: { $elemMatch: { staffId, start: { $lt: end }, end: { $gt: start } } },
    };

    if (excludeAppointmentId) {
      aptQuery._id = { $ne: excludeAppointmentId };
    }

    const conflictingApt = await Appointment.findOne(aptQuery).session(session || null);
    if (conflictingApt) {
      throw new AppError(409, 'SLOT_CLASH', `Staff ${staff.name} already has an appointment during this time window`);
    }
  }

  /**
   * Resolves the lines of a booking: service duration, a free stylist for "any available", the
   * per-staff slot lock and every clash rule. Two lines of the same booking may not overlap for
   * one stylist either.
   */
  private async buildLines(
    businessId: Types.ObjectId,
    branchId: Types.ObjectId,
    inputLines: { serviceId: string; staffId?: string; start: string }[],
    session: ClientSession,
    excludeAppointmentId?: Types.ObjectId
  ): Promise<any[]> {
    const lines: any[] = [];
    const clashesWithEarlierLine = (staffId: Types.ObjectId, start: Date, end: Date) =>
      lines.some((l) => l.staffId.equals(staffId) && overlaps(l, { start, end }));

    for (const line of inputLines) {
      const serviceId = toObjectId(line.serviceId);
      const service = await Service.findOne({ _id: serviceId, businessId, active: true }).session(session);
      if (!service) {
        throw new AppError(404, 'NOT_FOUND', `Service ${line.serviceId} not found`);
      }

      const lineStart = new Date(line.start);
      const lineEnd = new Date(lineStart.getTime() + service.durationMin * 60 * 1000);

      let staffId: Types.ObjectId;
      if (line.staffId) {
        staffId = toObjectId(line.staffId);
        if (clashesWithEarlierLine(staffId, lineStart, lineEnd)) {
          throw new AppError(409, 'SLOT_CLASH', 'Two services in this booking overlap for the same stylist');
        }
      } else {
        // "Any available": first active service provider of the branch who is free
        const candidates = await Staff.find({
          businessId,
          branchId,
          status: 'active',
          designation: { $nin: NON_SERVICE_DESIGNATIONS },
          ...(service.eligibleStaffIds.length > 0 ? { _id: { $in: service.eligibleStaffIds } } : {}),
        })
          .sort({ createdAt: 1 })
          .session(session);

        let freeStaff: any = null;
        for (const s of candidates) {
          if (clashesWithEarlierLine(s._id, lineStart, lineEnd)) continue;
          try {
            await this.checkSlotClash(businessId, branchId, s._id, serviceId, lineStart, lineEnd, excludeAppointmentId, session);
            freeStaff = s;
            break;
          } catch (err) {
            if (!(err instanceof AppError)) throw err;
          }
        }

        if (!freeStaff) {
          throw new AppError(409, 'SLOT_CLASH', `No eligible staff available for ${service.name} at ${formatIstTime(lineStart)}`);
        }
        staffId = freeStaff._id;
      }

      // Per-staff, per-day slot lock: concurrent bookings for one stylist conflict on this
      // document, so the transaction retries and the second one sees the first booking.
      const businessDate = getBusinessDate(lineStart);
      const lockKey = `${businessId}:${staffId}:slotlock:${businessDate}`;
      await Counter.findByIdAndUpdate(lockKey, { $inc: { seq: 1 } }, { upsert: true, new: true, session });

      await this.checkSlotClash(businessId, branchId, staffId, serviceId, lineStart, lineEnd, excludeAppointmentId, session);

      lines.push({
        _id: new Types.ObjectId(),
        serviceId,
        serviceName: service.name,
        staffId,
        start: lineStart,
        end: lineEnd,
      });
    }

    return lines;
  }

  /**
   * Creates an appointment with clash checks, customer inline-creation, and slot lock concurrency.
   */
  async createAppointment(ctx: RequestContext, branchIdStr: string, data: any): Promise<IAppointment> {
    const businessId = toObjectId(ctx.businessId!);
    const branchId = toObjectId(branchIdStr);

    return withTransaction(async (session) => {
      // 1. Resolve Customer
      let customerId: Types.ObjectId;
      if (data.customerId) {
        customerId = toObjectId(data.customerId);
        if (!(await Customer.exists({ _id: customerId, businessId }).session(session))) {
          throw new AppError(404, 'NOT_FOUND', 'Customer not found');
        }
      } else {
        const phone = normalizePhone(data.newCustomer.phone);
        let customer = await Customer.findOne({ businessId, phone }).session(session);
        if (!customer) {
          customer = new Customer({
            businessId,
            name: data.newCustomer.name,
            phone,
            source: data.source || 'phone',
            tags: [],
            waOptIn: true,
            doNotMessage: false,
            stats: { visits: 0, spendPaise: 0, noShows: 0 },
            walletBalancePaise: 0,
            loyaltyPoints: 0,
            duePaise: 0,
          });
          await customer.save({ session });
        }
        customerId = customer._id;
      }

      // 2. Prepare lines and check clashes
      const lines = await this.buildLines(businessId, branchId, data.lines, session);
      const minStart = new Date(Math.min(...lines.map((l) => l.start.getTime())));
      const maxEnd = new Date(Math.max(...lines.map((l) => l.end.getTime())));
      const businessDate = getBusinessDate(minStart);

      const appointment = new Appointment({
        businessId,
        branchId,
        customerId,
        businessDate,
        lines,
        start: minStart,
        end: maxEnd,
        status: 'booked',
        statusLog: [
          {
            status: 'booked',
            at: new Date(),
            by: toObjectId(ctx.userId),
            reason: 'Initial booking',
          },
        ],
        source: data.source || 'phone',
        notes: data.notes,
      });

      await appointment.save({ session });

      await auditService.logAction({
        ctx,
        action: 'appointment.create',
        entity: 'appointment',
        entityId: appointment._id,
        branchId,
        after: { customerId, businessDate, linesCount: lines.length },
        session,
      });

      return appointment;
    });
  }

  /**
   * Reschedules an appointment (time, stylist or services) or edits its notes. Optimistic
   * concurrency: the caller sends the __v it loaded; a stale one is a 409.
   */
  async rescheduleAppointment(
    ctx: RequestContext,
    id: string,
    data: { lines?: { serviceId: string; staffId?: string; start: string }[]; notes?: string; __v: number }
  ): Promise<IAppointment> {
    const businessId = toObjectId(ctx.businessId!);

    return withTransaction(async (session) => {
      const appointment = await Appointment.findOne({ _id: toObjectId(id), businessId }).session(session);
      if (!appointment) {
        throw new AppError(404, 'NOT_FOUND', 'Appointment not found');
      }
      assertBranchScope(ctx, appointment.branchId);
      if (appointment.__v !== data.__v) {
        throw new AppError(409, 'VERSION_CONFLICT', 'The appointment was changed by someone else; reload and try again');
      }
      if (!['booked', 'confirmed'].includes(appointment.status)) {
        throw new AppError(422, 'INVALID_TRANSITION', `A ${appointment.status} appointment cannot be rescheduled`);
      }

      const { start: prevStart, end: prevEnd, lines: prevLines } = appointment.toObject();
      const before = { start: prevStart, end: prevEnd, lines: prevLines };

      if (data.lines) {
        const lines = await this.buildLines(businessId, appointment.branchId, data.lines, session, appointment._id);
        appointment.lines = lines as any;
        appointment.start = new Date(Math.min(...lines.map((l) => l.start.getTime())));
        appointment.end = new Date(Math.max(...lines.map((l) => l.end.getTime())));
        appointment.businessDate = getBusinessDate(appointment.start);
        appointment.statusLog.push({ status: appointment.status, at: new Date(), by: toObjectId(ctx.userId), reason: 'Rescheduled' });
      }
      if (data.notes !== undefined) appointment.notes = data.notes;

      await appointment.save({ session }); // optimisticConcurrency bumps __v

      await auditService.logAction({
        ctx,
        action: 'appointment.reschedule',
        entity: 'appointment',
        entityId: appointment._id,
        branchId: appointment.branchId,
        before,
        after: { start: appointment.start, end: appointment.end, notes: appointment.notes },
        session,
      });

      return appointment;
    });
  }

  /**
   * Free start times per eligible stylist for one service on one day, in steps of stepMin.
   * A slot is free when the stylist is rostered, not on leave, not blocked, has no booking in
   * [start, start + duration) and the branch is open. Past times today are left out.
   */
  async getAvailability(
    ctx: RequestContext,
    branchIdStr: string,
    query: { serviceId: string; date: string; staffId?: string; stepMin?: number }
  ): Promise<any> {
    const businessId = toObjectId(ctx.businessId!);
    const branchId = toObjectId(branchIdStr);
    const date = query.date;
    const step = query.stepMin || 15;

    const [branch, service] = await Promise.all([
      Branch.findOne({ _id: branchId, businessId }),
      Service.findOne({ _id: toObjectId(query.serviceId), businessId }),
    ]);
    if (!branch) throw new AppError(404, 'NOT_FOUND', 'Branch not found');
    if (!service || !service.active) throw new AppError(404, 'NOT_FOUND', 'Service not found');

    const result = { date, serviceId: service._id, serviceName: service.name, durationMin: service.durationMin, stepMin: step, staff: [] as any[] };

    const dayOfWeek = getIstDayOfWeek(parseIstDateTime(date, '12:00'));
    const hours = branch.hours.find((h) => h.day === dayOfWeek);
    const branchPrice = service.branchPrices.find((bp) => bp.branchId.equals(branchId));
    if (branch.holidays.some((h) => h.date === date) || !hours || hours.closed || !hours.open || !hours.close || branchPrice?.active === false) {
      return result;
    }

    const staffQuery: any = { businessId, branchId, status: 'active', designation: { $nin: NON_SERVICE_DESIGNATIONS } };
    if (query.staffId) staffQuery._id = toObjectId(query.staffId);
    const staffList = (await Staff.find(staffQuery).sort({ createdAt: 1 })).filter(
      (st) =>
        (service.eligibleStaffIds.length === 0 || service.eligibleStaffIds.some((id) => id.equals(st._id))) &&
        (st.serviceIds.length === 0 || st.serviceIds.some((id) => id.equals(service._id)))
    );
    if (staffList.length === 0) return result;

    const staffIds = staffList.map((st) => st._id);
    const dayStart = parseIstDateTime(date, '00:00');
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const [rosters, leaves, blocks, appointments] = await Promise.all([
      Roster.find({ businessId, staffId: { $in: staffIds } }),
      Leave.find({ businessId, staffId: { $in: staffIds }, status: 'approved', from: { $lte: date }, to: { $gte: date } }),
      StaffBlock.find({ businessId, staffId: { $in: staffIds }, start: { $lt: dayEnd }, end: { $gt: dayStart } }),
      Appointment.find({ businessId, branchId, status: { $nin: FREED_STATUSES }, start: { $lt: dayEnd }, end: { $gt: dayStart } }),
    ]);

    const now = new Date();
    const durationMs = service.durationMin * 60 * 1000;

    for (const st of staffList) {
      if (leaves.some((l) => l.staffId.equals(st._id))) continue;

      let open = hours.open;
      let close = hours.close;
      const roster = rosters.find((r) => r.staffId.equals(st._id));
      const slot = roster && (roster.overrides.find((o) => o.date === date) || roster.weekly.find((d) => d.day === dayOfWeek));
      if (slot) {
        if (slot.off) continue;
        if (slot.start && slot.start > open) open = slot.start;
        if (slot.end && slot.end < close) close = slot.end;
      }

      const busy = [
        ...blocks.filter((b) => b.staffId.equals(st._id)).map((b) => ({ start: b.start, end: b.end })),
        ...appointments.flatMap((a) => a.lines.filter((l) => l.staffId.equals(st._id)).map((l) => ({ start: l.start, end: l.end }))),
      ];

      const slots: string[] = [];
      const last = parseIstDateTime(date, close).getTime() - durationMs;
      for (let t = parseIstDateTime(date, open).getTime(); t <= last; t += step * 60 * 1000) {
        const candidate = { start: new Date(t), end: new Date(t + durationMs) };
        if (candidate.start < now) continue;
        if (busy.some((b) => overlaps(b, candidate))) continue;
        slots.push(formatIstTime(candidate.start));
      }

      result.staff.push({ staffId: st._id, name: st.name, designation: st.designation, slots });
    }

    return result;
  }

  /**
   * Quick walk-in appointment creation starting now.
   */
  async createWalkIn(ctx: RequestContext, branchIdStr: string, data: any): Promise<IAppointment> {
    const now = new Date();
    // Round now to next 5 minutes
    const remainder = 5 * 60 * 1000 - (now.getTime() % (5 * 60 * 1000));
    let startTime = new Date(now.getTime() + remainder);

    const linesInput: any[] = [];
    for (const serviceId of data.serviceIds) {
      linesInput.push({
        serviceId,
        start: startTime.toISOString(),
      });
      // Look up service duration to increment startTime for next service
      const svc = await Service.findOne({ _id: toObjectId(serviceId), businessId: toObjectId(ctx.businessId!) });
      if (!svc) {
        throw new AppError(404, 'NOT_FOUND', `Service ${serviceId} not found`);
      }
      const durationMin = svc.durationMin;
      startTime = new Date(startTime.getTime() + durationMin * 60 * 1000);
    }

    return this.createAppointment(ctx, branchIdStr, {
      customerId: data.customerId,
      newCustomer: data.newCustomer,
      lines: linesInput,
      source: 'walk_in',
      notes: data.notes || 'Walk-in customer',
    });
  }

  /**
   * Updates an appointment's status according to the valid status lifecycle.
   */
  async updateStatus(ctx: RequestContext, id: string, newStatus: string, reason?: string): Promise<IAppointment> {
    const businessId = toObjectId(ctx.businessId!);
    const appointment = await Appointment.findOne({ _id: toObjectId(id), businessId });
    if (!appointment) {
      throw new AppError(404, 'NOT_FOUND', 'Appointment not found');
    }
    assertBranchScope(ctx, appointment.branchId);

    const currentStatus = appointment.status;
    const allowed = VALID_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(newStatus)) {
      throw new AppError(
        422,
        'INVALID_TRANSITION',
        `Cannot transition appointment from '${currentStatus}' to '${newStatus}'`
      );
    }

    // Arrived condition check: appointment date must be today
    if (newStatus === 'arrived') {
      const today = getBusinessDate(new Date());
      if (appointment.businessDate !== today) {
        throw new AppError(422, 'INVALID_TRANSITION', 'Status Arrived can only be marked on the day of appointment');
      }
    }

    // Cancelled and No-show reason
    if (newStatus === 'cancelled' && !reason) {
      throw new AppError(422, 'VALIDATION_ERROR', 'Reason is required when cancelling an appointment');
    }

    if (newStatus === 'no_show') {
      // Increment noShow counter on customer
      await Customer.updateOne(
        { _id: appointment.customerId, businessId },
        { $inc: { 'stats.noShows': 1 } }
      );
    }

    appointment.status = newStatus as any;
    appointment.statusLog.push({
      status: newStatus,
      at: new Date(),
      by: toObjectId(ctx.userId),
      reason,
    });

    await appointment.save();

    await auditService.logAction({
      ctx,
      action: `appointment.status_${newStatus}`,
      entity: 'appointment',
      entityId: appointment._id,
      branchId: appointment.branchId,
      before: { status: currentStatus },
      after: { status: newStatus, reason },
    });

    // await notificationService.bumpScope(
    //   businessId.toString(),
    //   `appointments:${appointment.branchId.toString()}:${appointment.businessDate}`
    // );

    return appointment;
  }

  /**
   * Calendar data for a date range (default: one day): appointments with customer names, the
   * branch's bookable staff (calendar columns), their rosters, approved leave and staff blocks.
   */
  async getAppointments(
    ctx: RequestContext,
    branchIdStr: string,
    filters: { from?: string; to?: string; staffId?: string; status?: string; customerId?: string }
  ): Promise<any> {
    const businessId = toObjectId(ctx.businessId!);
    const branchId = toObjectId(branchIdStr);
    const from = filters.from || getBusinessDate();
    const to = filters.to || from;

    const query: any = { businessId, branchId, businessDate: { $gte: from, $lte: to } };
    if (filters.staffId) query['lines.staffId'] = toObjectId(filters.staffId);
    if (filters.status) query.status = filters.status;
    if (filters.customerId) query.customerId = toObjectId(filters.customerId);

    const rangeStart = parseIstDateTime(from, '00:00');
    const rangeEnd = new Date(parseIstDateTime(to, '00:00').getTime() + 24 * 60 * 60 * 1000);
    const staffFilter = filters.staffId ? { _id: toObjectId(filters.staffId) } : {};

    const [appointments, staff, staffBlocks] = await Promise.all([
      Appointment.find(query).sort({ start: 1 }).populate('customerId', 'name phone'),
      Staff.find({ businessId, branchId, status: 'active', designation: { $nin: NON_SERVICE_DESIGNATIONS }, ...staffFilter })
        .select('name designation serviceIds')
        .sort({ createdAt: 1 }),
      StaffBlock.find({
        businessId,
        branchId,
        start: { $lt: rangeEnd },
        end: { $gt: rangeStart },
        ...(filters.staffId ? { staffId: toObjectId(filters.staffId) } : {}),
      }).sort({ start: 1 }),
    ]);
    const staffIds = staff.map((st) => st._id);
    const [rosters, leaves] = await Promise.all([
      Roster.find({ businessId, staffId: { $in: staffIds } }).select('staffId weekly overrides'),
      Leave.find({ businessId, staffId: { $in: staffIds }, status: 'approved', from: { $lte: to }, to: { $gte: from } }).select('staffId from to type'),
    ]);

    return {
      from,
      to,
      appointments: appointments.map((a) => presentCustomer(ctx, a)),
      staff,
      rosters,
      leaves,
      staffBlocks,
    };
  }

  /**
   * Blocks a stylist's time (lunch, training, …). Bookings can't be made into a block.
   */
  async createStaffBlock(
    ctx: RequestContext,
    branchIdStr: string,
    data: { staffId: string; start: string; end: string; reason: string }
  ): Promise<any> {
    const businessId = toObjectId(ctx.businessId!);
    const branchId = toObjectId(branchIdStr);
    if (!(await Staff.exists({ _id: toObjectId(data.staffId), businessId, branchId }))) {
      throw new AppError(404, 'NOT_FOUND', 'Staff member not found in this branch');
    }

    const block = new StaffBlock({
      businessId,
      branchId,
      staffId: toObjectId(data.staffId),
      start: new Date(data.start),
      end: new Date(data.end),
      reason: data.reason,
    });
    await block.save();

    await auditService.logAction({
      ctx,
      action: 'staff_block.create',
      entity: 'staffBlock',
      entityId: block._id,
      branchId,
      after: { staffId: data.staffId, start: data.start, end: data.end, reason: data.reason },
    });

    return block;
  }

  async deleteStaffBlock(ctx: RequestContext, branchIdStr: string, blockId: string): Promise<void> {
    const businessId = toObjectId(ctx.businessId!);
    const res = await StaffBlock.deleteOne({ _id: toObjectId(blockId), businessId, branchId: toObjectId(branchIdStr) });
    if (res.deletedCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Staff block not found');
    }
  }

  async getAppointmentById(ctx: RequestContext, id: string): Promise<any> {
    const businessId = toObjectId(ctx.businessId!);
    const apt = await Appointment.findOne({ _id: toObjectId(id), businessId })
      .populate('customerId', 'name phone')
      .populate('lines.serviceId', 'name')
      .populate('lines.staffId', 'name');
    if (!apt) {
      throw new AppError(404, 'NOT_FOUND', 'Appointment not found');
    }
    assertBranchScope(ctx, apt.branchId);
    return presentCustomer(ctx, apt);
  }
}

export const appointmentService = new AppointmentService();
