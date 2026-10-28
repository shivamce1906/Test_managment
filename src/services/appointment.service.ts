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
} from '../utils';
import { RequestContext, toObjectId } from './context';
import { auditService } from './audit.service';
import { notificationService } from './notification.service';

const VALID_TRANSITIONS: Record<string, string[]> = {
  booked: ['confirmed', 'arrived', 'cancelled', 'no_show'],
  confirmed: ['arrived', 'in_service', 'cancelled', 'no_show'],
  arrived: ['in_service', 'cancelled'],
  in_service: ['completed'],
  completed: ['billed'],
  cancelled: [],
  no_show: [],
  billed: [],
};

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

    if (service.eligibleStaffIds.length > 0) {
      const isEligible = service.eligibleStaffIds.some((id) => id.equals(staffId));
      if (!isEligible) {
        throw new AppError(409, 'SLOT_CLASH', `Staff member ${staff.name} is not eligible for service ${service.name}`);
      }
    }

    if (staff.serviceIds && staff.serviceIds.length > 0) {
      const isEligible = staff.serviceIds.some((id: any) => id.equals(serviceId));
      if (!isEligible) {
        throw new AppError(409, 'SLOT_CLASH', `Staff member ${staff.name} is not eligible for service ${service.name}`);
      }
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

    // 6. Check existing appointments
    const aptQuery: any = {
      businessId,
      branchId,
      status: { $nin: ['cancelled', 'no_show'] },
      'lines.staffId': staffId,
      start: { $lt: end },
      end: { $gt: start },
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
        const existingCustomer = await Customer.findOne({ _id: customerId, businessId }).session(session);
        if (!existingCustomer) {
          throw new AppError(404, 'NOT_FOUND', 'Customer not found in this business');
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
      const lines: any[] = [];
      let minStart = new Date(8640000000000000);
      let maxEnd = new Date(-8640000000000000);

      for (const line of data.lines) {
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
        } else {
          // Find first available eligible staff
          const eligibleStaff = await Staff.find({
            businessId,
            branchId,
            status: 'active',
            designation: { $nin: ['receptionist', 'helper'] },
            ...(service.eligibleStaffIds.length > 0 ? { _id: { $in: service.eligibleStaffIds } } : {}),
            $or: [{ serviceIds: { $size: 0 } }, { serviceIds: serviceId }],
          }).session(session);

          let freeStaff: any = null;
          for (const s of eligibleStaff) {
            try {
              await this.checkSlotClash(businessId, branchId, s._id, serviceId, lineStart, lineEnd, undefined, session);
              freeStaff = s;
              break;
            } catch {
              // clash, try next
            }
          }

          if (!freeStaff) {
            throw new AppError(409, 'SLOT_CLASH', `No eligible staff available for ${service.name} at ${formatIstTime(lineStart)}`);
          }
          staffId = freeStaff._id;
        }

        // Concurrency slot lock increment
        const businessDate = getBusinessDate(lineStart);
        const lockKey = `${businessId}:${staffId}:slotlock:${businessDate}`;
        await Counter.findByIdAndUpdate(
          lockKey,
          { $inc: { seq: 1 } },
          { upsert: true, new: true, session }
        );

        // Run clash check
        await this.checkSlotClash(businessId, branchId, staffId, serviceId, lineStart, lineEnd, undefined, session);

        lines.push({
          _id: new Types.ObjectId(),
          serviceId,
          serviceName: service.name,
          staffId,
          start: lineStart,
          end: lineEnd,
        });

        if (lineStart < minStart) minStart = lineStart;
        if (lineEnd > maxEnd) maxEnd = lineEnd;
      }

      // Check for clashes between lines within this same appointment
      for (let i = 0; i < lines.length; i++) {
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[i].staffId.equals(lines[j].staffId)) {
            if (isOverlapping(lines[i].start, lines[i].end, lines[j].start, lines[j].end)) {
              throw new AppError(409, 'SLOT_CLASH', 'Staff cannot be double-booked for overlapping lines in the same appointment');
            }
          }
        }
      }

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

      // Bump change cursor for calendar screen
      await notificationService.bumpScope(businessId.toString(), `appointments:${branchIdStr}:${businessDate}`);

      return appointment;
    });
  }

  /**
   * Quick walk-in appointment creation starting now.
   */
  async createWalkIn(ctx: RequestContext, branchIdStr: string, data: any): Promise<IAppointment> {
    const now = new Date();
    // Round now to next 5 minutes
    const remainder = 5 * 60 * 1000 - (now.getTime() % (5 * 60 * 1000));
    let startTime = new Date(now.getTime() + remainder);

    const businessId = toObjectId(ctx.businessId!);
    const linesInput: any[] = [];
    for (const serviceId of data.serviceIds) {
      linesInput.push({
        serviceId,
        start: startTime.toISOString(),
      });
      // Look up service duration to increment startTime for next service
      const svc = await Service.findOne({ _id: toObjectId(serviceId), businessId });
      const durationMin = svc ? svc.durationMin : 30;
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

    if (ctx.role === 'branch') {
      const allowed = ctx.branchId === appointment.branchId.toString() || ctx.branchIds?.includes(appointment.branchId.toString());
      if (!allowed) throw new AppError(403, 'FORBIDDEN', 'Access denied to this branch appointment');
    }
    if (ctx.role === 'manager' && !ctx.branchIds?.includes(appointment.branchId.toString())) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied to this branch appointment');
    }

    if (newStatus === 'billed' && !appointment.billId) {
      throw new AppError(422, 'INVALID_TRANSITION', 'Cannot manually set status to billed without a bill');
    }

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

    await notificationService.bumpScope(
      businessId.toString(),
      `appointments:${appointment.branchId.toString()}:${appointment.businessDate}`
    );

    return appointment;
  }

  /**
   * Gets appointments for calendar day, week, or list view.
   */
  async getAppointments(
    ctx: RequestContext,
    branchIdStr: string,
    filters: { from?: string; to?: string; staffId?: string; status?: string }
  ): Promise<any> {
    const businessId = toObjectId(ctx.businessId!);
    const branchId = toObjectId(branchIdStr);

    const query: any = { businessId, branchId };

    if (filters.from && filters.to) {
      query.businessDate = { $gte: filters.from, $lte: filters.to };
    } else if (filters.from) {
      query.businessDate = filters.from;
    }

    if (filters.staffId) {
      query['lines.staffId'] = toObjectId(filters.staffId);
    }
    if (filters.status) {
      query.status = filters.status;
    }

    const appointments = await Appointment.find(query).sort({ start: 1 });
    const staffBlocks = await StaffBlock.find({
      businessId,
      branchId,
      ...(filters.staffId ? { staffId: toObjectId(filters.staffId) } : {}),
    });

    return { appointments, staffBlocks };
  }

  /**
   * Staff block operations.
   */
  async createStaffBlock(ctx: RequestContext, branchIdStr: string, data: any): Promise<any> {
    const businessId = toObjectId(ctx.businessId!);
    const branchId = toObjectId(branchIdStr);

    const block = new StaffBlock({
      businessId,
      branchId,
      staffId: toObjectId(data.staffId),
      start: new Date(data.start),
      end: new Date(data.end),
      reason: data.reason,
    });

    await block.save();
    return block;
  }

  async deleteStaffBlock(ctx: RequestContext, blockId: string): Promise<void> {
    const businessId = toObjectId(ctx.businessId!);
    await StaffBlock.deleteOne({ _id: toObjectId(blockId), businessId });
  }

  async getAppointmentById(ctx: RequestContext, id: string): Promise<IAppointment> {
    const businessId = toObjectId(ctx.businessId!);
    const apt = await Appointment.findOne({ _id: toObjectId(id), businessId })
      .populate({ path: 'customerId', select: 'name phone', options: { skipTenantScope: true } })
      .populate({ path: 'lines.serviceId', select: 'name', options: { skipTenantScope: true } })
      .populate({ path: 'lines.staffId', select: 'name', options: { skipTenantScope: true } });
    if (!apt) {
      throw new AppError(404, 'NOT_FOUND', 'Appointment not found');
    }

    if (ctx.role === 'branch' && ctx.branchId && ctx.branchId !== apt.branchId.toString()) {
      throw new AppError(403, 'FORBIDDEN', 'Access to appointment of another branch is forbidden');
    }
    if (ctx.role === 'manager' && ctx.branchIds && !ctx.branchIds.some((bId) => bId.toString() === apt.branchId.toString())) {
      throw new AppError(403, 'FORBIDDEN', 'Access to appointment of unassigned branch is forbidden');
    }

    return apt;
  }

  /**
   * Reschedules an appointment (re-checks slot clashes and intra-appointment clashes).
   */
  async rescheduleAppointment(ctx: RequestContext, id: string, updates: any): Promise<IAppointment> {
    const businessId = toObjectId(ctx.businessId!);
    const aptId = toObjectId(id);

    return withTransaction(async (session) => {
      const apt = await Appointment.findOne({ _id: aptId, businessId }).session(session);
      if (!apt) throw new AppError(404, 'NOT_FOUND', 'Appointment not found');

      if (ctx.role === 'branch' && ctx.branchId && ctx.branchId !== apt.branchId.toString()) {
        throw new AppError(403, 'FORBIDDEN', 'Access to appointment of another branch is forbidden');
      }
      if (ctx.role === 'manager' && ctx.branchIds && !ctx.branchIds.some((bId) => bId.toString() === apt.branchId.toString())) {
        throw new AppError(403, 'FORBIDDEN', 'Access to appointment of unassigned branch is forbidden');
      }

      if (apt.status === 'cancelled' || apt.status === 'billed') {
        throw new AppError(422, 'INVALID_TRANSITION', `Cannot reschedule a ${apt.status} appointment`);
      }

      if (updates.__v !== undefined && apt.__v !== updates.__v) {
        throw new AppError(409, 'VERSION_CONFLICT', 'Appointment was modified by another user');
      }

      if (updates.lines && updates.lines.length > 0) {
        const resolvedLines = [];
        let overallStart = new Date(updates.lines[0].start);
        let overallEnd = new Date(updates.lines[0].start);

        for (const raw of updates.lines) {
          const service = await Service.findOne({ _id: toObjectId(raw.serviceId), businessId, active: true }).session(session);
          if (!service) throw new AppError(404, 'NOT_FOUND', `Service ${raw.serviceId} not found`);

          const durationMin = raw.durationMin || service.durationMin;
          const lineStart = new Date(raw.start);
          const lineEnd = new Date(lineStart.getTime() + durationMin * 60000);

          if (lineStart < overallStart) overallStart = lineStart;
          if (lineEnd > overallEnd) overallEnd = lineEnd;

          const staff = await Staff.findOne({ _id: toObjectId(raw.staffId), businessId, status: 'active' }).session(session);
          if (!staff) throw new AppError(404, 'NOT_FOUND', `Staff ${raw.staffId} not found`);

          // Check slot clash excluding current appointment
          await this.checkSlotClash(businessId, apt.branchId, staff._id, service._id, lineStart, lineEnd, apt._id, session);

          resolvedLines.push({
            serviceId: service._id,
            serviceName: service.name,
            staffId: staff._id,
            staffName: staff.name,
            start: lineStart,
            end: lineEnd,
            durationMin,
            pricePaise: service.basePricePaise,
          });
        }

        // Check intra-appointment clashes
        for (let i = 0; i < resolvedLines.length; i++) {
          for (let j = i + 1; j < resolvedLines.length; j++) {
            const l1 = resolvedLines[i];
            const l2 = resolvedLines[j];
            if (l1.staffId.equals(l2.staffId)) {
              if (l1.start < l2.end && l1.end > l2.start) {
                throw new AppError(409, 'SLOT_CLASH', `Stylist ${l1.staffName} is assigned to overlapping services within this appointment`);
              }
            }
          }
        }

        apt.lines = resolvedLines as any;
        apt.start = overallStart;
        apt.end = overallEnd;
        apt.businessDate = getBusinessDate(overallStart);
      }

      if (updates.notes !== undefined) {
        apt.notes = updates.notes;
      }

      apt.statusLog.push({
        status: apt.status,
        at: new Date(),
        by: toObjectId(ctx.userId),
        reason: updates.reason || 'Rescheduled',
      });

      await apt.save({ session });

      await notificationService.bumpScope(
        businessId.toString(),
        `appointments:${apt.branchId.toString()}:${apt.businessDate}`
      );

      return apt;
    });
  }

  /**
   * Returns free slots on a given date for a service and/or staff.
   */
  async getBranchAvailability(
    ctx: RequestContext,
    branchIdStr: string,
    query: { serviceId?: string; staffId?: string; date: string }
  ): Promise<any> {
    const businessId = toObjectId(ctx.businessId!);
    const branchId = toObjectId(branchIdStr);

    const branch = await Branch.findOne({ _id: branchId, businessId });
    if (!branch) throw new AppError(404, 'NOT_FOUND', 'Branch not found');

    const businessDate = query.date;
    const isHoliday = branch.holidays.some((h) => h.date === businessDate);
    if (isHoliday) {
      return { date: businessDate, slots: [] };
    }

    const testDate = parseIstDateTime(businessDate, '12:00');
    const dayOfWeek = getIstDayOfWeek(testDate);
    const dayHours = branch.hours.find((h) => h.day === dayOfWeek);
    if (!dayHours || dayHours.closed || !dayHours.open || !dayHours.close) {
      return { date: businessDate, slots: [] };
    }

    let service: any = null;
    let durationMin = 30;
    if (query.serviceId) {
      service = await Service.findOne({ _id: toObjectId(query.serviceId), businessId, active: true });
      if (service) {
        durationMin = service.durationMin;
      }
    }

    // Find eligible staff
    let staffList = await Staff.find({
      businessId,
      branchId,
      status: 'active',
      designation: { $in: ['stylist', 'senior_stylist', 'beautician'] },
      ...(query.staffId ? { _id: toObjectId(query.staffId) } : {}),
    });

    if (service) {
      staffList = staffList.filter((s) => {
        if (service.eligibleStaffIds.length > 0 && !service.eligibleStaffIds.some((id: any) => id.equals(s._id))) {
          return false;
        }
        if (s.serviceIds && s.serviceIds.length > 0 && !s.serviceIds.some((id: any) => id.equals(service._id))) {
          return false;
        }
        return true;
      });
    }

    const branchOpenDate = parseIstDateTime(businessDate, dayHours.open);
    const branchCloseDate = parseIstDateTime(businessDate, dayHours.close);

    const freeSlots: any[] = [];
    const stepMs = 30 * 60000;

    for (let slotTime = branchOpenDate.getTime(); slotTime + durationMin * 60000 <= branchCloseDate.getTime(); slotTime += stepMs) {
      const start = new Date(slotTime);
      const end = new Date(slotTime + durationMin * 60000);

      const availableStaff = [];
      for (const st of staffList) {
        try {
          await this.checkSlotClash(businessId, branchId, st._id, service ? service._id : new Types.ObjectId(), start, end);
          availableStaff.push({ staffId: st._id, name: st.name });
        } catch {
          // Clash, ignore
        }
      }

      if (availableStaff.length > 0) {
        freeSlots.push({
          start: start.toISOString(),
          end: end.toISOString(),
          availableStaff,
        });
      }
    }

    return { date: businessDate, slots: freeSlots };
  }
}

export const appointmentService = new AppointmentService();
