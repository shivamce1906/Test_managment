import '../helpers/testEnv';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, World, dayOffset, ist, createRoster, createStaff, serviceLine } from '../helpers/factory';
import { Appointment, Branch, Customer, Leave, Service, Staff } from '../../src/models';
import { appointmentService } from '../../src/services';
import { getIstDayOfWeek, parseIstDateTime, getBusinessDate } from '../../src/utils';

const D = () => dayOffset(1);
const dow = (d: string) => getIstDayOfWeek(parseIstDateTime(d, '12:00'));

const book = (w: World, token: string, lines: any[], extra: any = {}, branch = w.branchA) =>
  as(token).post(`/branches/${branch._id}/appointments`, { customerId: w.customer._id.toString(), lines, source: 'phone', ...extra });
const line = (svc: any, staff: any, start: string) => ({ serviceId: svc._id.toString(), ...(staff ? { staffId: staff._id.toString() } : {}), start });

describe('Appointments — booking (PRD §5)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('books a 30-min haircut with a stylist; end = start + duration', async () => {
    const res = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))]);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('booked');
    expect(res.body.businessDate).toBe(D());
    expect(new Date(res.body.end).getTime() - new Date(res.body.start).getTime()).toBe(30 * 60000);
    expect(res.body.lines[0].serviceName).toBe('Haircut');
  });

  it('inline new customer (name + phone) is created with a normalised phone', async () => {
    const res = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))], {
      customerId: undefined, newCustomer: { name: 'Neha', phone: '98250 12345' },
    });
    expect(res.status).toBe(201);
    const c = await Customer.findOne({ businessId: w.business._id, phone: '+919825012345' });
    expect(c?.name).toBe('Neha');
  });

  it('inline customer with an existing phone reuses that customer (no duplicate)', async () => {
    await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))], {
      customerId: undefined, newCustomer: { name: 'Someone', phone: '9876543210' },
    });
    expect(await Customer.countDocuments({ businessId: w.business._id, phone: '+919876543210' })).toBe(1);
  });

  it('multi-service booking keeps each line\'s own staff and time', async () => {
    const res = await book(w, w.tokens.branchA, [
      line(w.haircut, w.stylist1, ist(D(), '11:00')),
      line(w.colour, w.stylist2, ist(D(), '11:30')),
    ]);
    expect(res.status).toBe(201);
    expect(res.body.lines).toHaveLength(2);
    expect(new Date(res.body.end).toISOString()).toBe(ist(D(), '13:00'));
  });

  it('booking source is recorded', async () => {
    const res = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))], { source: 'whatsapp' });
    expect(res.body.source).toBe('whatsapp');
  });

  it('staff from another branch cannot be booked here', async () => {
    const res = await book(w, w.tokens.owner, [line(w.haircut, w.stylistB, ist(D(), '11:00'))]);
    expect(res.status).toBe(404);
  });

  it('unknown service -> 404', async () => {
    const res = await book(w, w.tokens.owner, [{ serviceId: '000000000000000000000000', staffId: w.stylist1._id.toString(), start: ist(D(), '11:00') }]);
    expect(res.status).toBe(404);
  });

  it('validation: no lines / bad date / no customer -> 400', async () => {
    expect((await book(w, w.tokens.owner, [])).status).toBe(400);
    expect((await book(w, w.tokens.owner, [{ serviceId: w.haircut._id.toString(), start: 'tomorrow' }])).status).toBe(400);
    expect((await book(w, w.tokens.owner, [line(w.haircut, w.stylist1, ist(D(), '11:00'))], { customerId: undefined })).status).toBe(400);
  });

  it('GET calendar returns the day\'s appointments for the branch', async () => {
    await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))]);
    await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(dayOffset(2), '11:00'))]);
    const res = await as(w.tokens.branchA).get(`/branches/${w.branchA._id}/appointments?from=${D()}`);
    expect(res.status).toBe(200);
    expect(res.body.appointments).toHaveLength(1);
  });
});

describe('Appointments — slot rules (BR-04, per-staff clashes)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('same stylist, overlapping time -> 409 SLOT_CLASH', async () => {
    await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))]);
    const res = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:15'))]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SLOT_CLASH');
  });

  it('YOUR RULE: same time slot, different stylists -> both allowed', async () => {
    const a = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))]);
    const b = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist2, ist(D(), '11:00'))]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it('YOUR RULE: 6 customers at 11:00 with 6 different stylists all book (chair count not checked)', async () => {
    const extra = await Promise.all([1, 2, 3, 4].map((i) => createStaff(w.business._id, w.branchA._id, { name: `Extra ${i}` })));
    await Branch.updateOne({ _id: w.branchA._id, businessId: w.business._id }, { $set: { stations: 2 } });
    const staff = [w.stylist1, w.stylist2, ...extra];
    for (const s of staff) {
      const r = await book(w, w.tokens.branchA, [line(w.haircut, s, ist(D(), '11:00'))]);
      expect(r.status).toBe(201);
    }
  });

  it('back-to-back slots for the same stylist are fine', async () => {
    await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))]);
    const res = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:30'))]);
    expect(res.status).toBe(201);
  });

  it('EDGE: two lines in ONE appointment overlapping for the same stylist -> clash', async () => {
    const res = await book(w, w.tokens.branchA, [
      line(w.haircut, w.stylist1, ist(D(), '11:00')),
      line(w.colour, w.stylist1, ist(D(), '11:10')),
    ]);
    expect(res.status).toBe(409);
  });

  it('cancelled appointment frees the slot', async () => {
    const a = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))]);
    await as(w.tokens.branchA).patch(`/appointments/${a.body._id}/status`, { status: 'cancelled', reason: 'Customer called' });
    const res = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))]);
    expect(res.status).toBe(201);
  });

  it('before opening time -> 409', async () => {
    const res = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '09:45'))]);
    expect(res.status).toBe(409);
  });

  it('service running past closing time -> 409 (19:45 + 30 min > 20:00)', async () => {
    const res = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '19:45'))]);
    expect(res.status).toBe(409);
  });

  it('exactly ending at closing time is allowed (19:30 + 30 min)', async () => {
    const res = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '19:30'))]);
    expect(res.status).toBe(201);
  });

  it('branch holiday -> 409', async () => {
    await Branch.updateOne({ _id: w.branchA._id, businessId: w.business._id }, { $set: { holidays: [{ date: D(), name: 'Diwali' }] } });
    const res = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))]);
    expect(res.status).toBe(409);
  });

  it('branch closed weekday -> 409', async () => {
    const hours = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day: d, open: '10:00', close: '20:00', closed: d === dow(D()) }));
    await Branch.updateOne({ _id: w.branchA._id, businessId: w.business._id }, { $set: { hours } });
    const res = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))]);
    expect(res.status).toBe(409);
  });

  it('stylist on approved leave -> 409; rejected leave does not block', async () => {
    await Leave.create({ businessId: w.business._id, branchId: w.branchA._id, staffId: w.stylist1._id, from: D(), to: D(), type: 'paid', status: 'approved' });
    await Leave.create({ businessId: w.business._id, branchId: w.branchA._id, staffId: w.stylist2._id, from: D(), to: D(), type: 'paid', status: 'rejected' });
    expect((await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))])).status).toBe(409);
    expect((await book(w, w.tokens.branchA, [line(w.haircut, w.stylist2, ist(D(), '11:00'))])).status).toBe(201);
  });

  it('roster: weekly off day -> 409; outside shift -> 409; inside shift -> 201', async () => {
    await createRoster(w, w.stylist1._id, [{ day: dow(D()), start: '12:00', end: '18:00', off: false }]);
    await createRoster(w, w.stylist2._id, [{ day: dow(D()), off: true }]);
    expect((await book(w, w.tokens.branchA, [line(w.haircut, w.stylist2, ist(D(), '13:00'))])).status).toBe(409);
    expect((await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))])).status).toBe(409);
    expect((await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '13:00'))])).status).toBe(201);
  });

  it('roster: date override (day off) beats the weekly template', async () => {
    await createRoster(w, w.stylist1._id, [{ day: dow(D()), start: '10:00', end: '20:00', off: false }], [{ date: D(), off: true }]);
    expect((await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))])).status).toBe(409);
  });

  it('staff block (lunch) -> 409', async () => {
    const blk = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/staff-blocks`, {
      staffId: w.stylist1._id.toString(), start: ist(D(), '13:00'), end: ist(D(), '14:00'), reason: 'Lunch',
    });
    expect(blk.status).toBe(201);
    expect((await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '13:15'))])).status).toBe(409);
  });

  it('staff block with end before start -> 400', async () => {
    const blk = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/staff-blocks`, {
      staffId: w.stylist1._id.toString(), start: ist(D(), '14:00'), end: ist(D(), '13:00'), reason: 'Lunch',
    });
    expect(blk.status).toBe(400);
  });

  it('service eligibility via service.eligibleStaffIds -> 409 for others', async () => {
    await Service.updateOne({ _id: w.colour._id, businessId: w.business._id }, { $set: { eligibleStaffIds: [w.stylist2._id] } });
    expect((await book(w, w.tokens.branchA, [line(w.colour, w.stylist1, ist(D(), '11:00'))])).status).toBe(409);
  });

  it('service eligibility via staff.serviceIds (Database Design: "the only source") -> 409', async () => {
    await Staff.updateOne({ _id: w.stylist1._id, businessId: w.business._id }, { $set: { serviceIds: [w.haircut._id] } });
    const res = await book(w, w.tokens.branchA, [line(w.colour, w.stylist1, ist(D(), '11:00'))]);
    expect(res.status).toBe(409);
  });

  it('"Any available" picks a free stylist, never the receptionist', async () => {
    await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))]);
    const res = await book(w, w.tokens.branchA, [line(w.haircut, null, ist(D(), '11:00'))]);
    expect(res.status).toBe(201);
    expect(res.body.lines[0].staffId).toBe(w.stylist2._id.toString());
  });

  it('"Any available" with everyone busy -> 409', async () => {
    await Staff.updateOne({ _id: w.receptionist._id, businessId: w.business._id }, { $set: { status: 'exited' } });
    await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))]);
    await book(w, w.tokens.branchA, [line(w.haircut, w.stylist2, ist(D(), '11:00'))]);
    expect((await book(w, w.tokens.branchA, [line(w.haircut, null, ist(D(), '11:00'))])).status).toBe(409);
  });

  it('exited stylist cannot be booked', async () => {
    await Staff.updateOne({ _id: w.stylist1._id, businessId: w.business._id }, { $set: { status: 'exited' } });
    expect((await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))])).status).toBe(404);
  });
});

describe('Appointments — status lifecycle and walk-ins', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
    // open all day so "today" bookings work whatever the time the suite runs
    const hours = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day: d, open: '00:00', close: '23:59', closed: false }));
    await Branch.updateOne({ _id: w.branchA._id, businessId: w.business._id }, { $set: { hours } });
  });

  const status = (w: World, id: string, s: string, reason?: string) =>
    as(w.tokens.branchA).patch(`/appointments/${id}/status`, { status: s, ...(reason ? { reason } : {}) });

  it('full happy path booked -> confirmed -> arrived -> in_service -> completed -> billed via bill', async () => {
    const today = getBusinessDate();
    const a = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(today, '23:00'))]);
    for (const s of ['confirmed', 'arrived', 'in_service', 'completed']) {
      const r = await status(w, a.body._id, s);
      expect(r.status).toBe(200);
      expect(r.body.status).toBe(s);
    }
    const bill = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), billedByStaffId: w.receptionist._id.toString(), appointmentId: a.body._id,
      lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 118000 }],
    });
    expect(bill.status).toBe(201);
    const apt = await Appointment.findOne({ _id: a.body._id, businessId: w.business._id });
    expect(apt!.status).toBe('billed');
    expect(apt!.billId!.toString()).toBe(bill.body._id);
    expect(apt!.statusLog.map((l) => l.status)).toEqual(['booked', 'confirmed', 'arrived', 'in_service', 'completed', 'billed']);
  });

  it('illegal jump booked -> completed -> 422 INVALID_TRANSITION', async () => {
    const a = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))]);
    const r = await status(w, a.body._id, 'completed');
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('cancel requires a reason', async () => {
    const a = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))]);
    expect((await status(w, a.body._id, 'cancelled')).status).toBe(422);
    expect((await status(w, a.body._id, 'cancelled', 'Unwell')).status).toBe(200);
  });

  it('cancelled is terminal', async () => {
    const a = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))]);
    await status(w, a.body._id, 'cancelled', 'x');
    expect((await status(w, a.body._id, 'confirmed')).status).toBe(422);
  });

  it('"arrived" only on the appointment day', async () => {
    const a = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))]);
    expect((await status(w, a.body._id, 'arrived')).status).toBe(422);
  });

  it('no-show increments the customer\'s no-show count', async () => {
    const a = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))]);
    await status(w, a.body._id, 'no_show');
    expect((await Customer.findOne({ _id: w.customer._id, businessId: w.business._id }))!.stats.noShows).toBe(1);
  });

  it('a "billed" status cannot be set by hand without a bill', async () => {
    const today = getBusinessDate();
    const a = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(today, '23:00'))]);
    for (const s of ['confirmed', 'arrived', 'in_service', 'completed']) await status(w, a.body._id, s);
    const r = await status(w, a.body._id, 'billed');
    expect(r.status).toBe(422);
  });

  it('walk-in creates an appointment starting now with the first free stylist', async () => {
    const res = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/walk-in`, {
      customerId: w.customer._id.toString(), serviceIds: [w.haircut._id.toString()],
    });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe('walk_in');
    expect(Math.abs(new Date(res.body.start).getTime() - Date.now())).toBeLessThan(6 * 60000);
  });

  it('reschedule endpoint PATCH /appointments/:id re-checks clashes (Backend SRS §6)', async () => {
    const a = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))]);
    await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '12:00'))]);
    const res = await as(w.tokens.branchA).patch(`/appointments/${a.body._id}`, {
      lines: [line(w.haircut, w.stylist1, ist(D(), '12:10'))], __v: a.body.__v,
    });
    expect(res.status).toBe(409);
  });

  it('availability endpoint lists free slots (Backend SRS §6)', async () => {
    const res = await as(w.tokens.branchA).get(`/branches/${w.branchA._id}/availability?serviceId=${w.haircut._id}&date=${D()}`);
    expect(res.status).toBe(200);
  });
});

describe('Appointments — concurrency (Backend SRS §12: parallel bookings on one slot -> exactly one succeeds)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  const ctx = (w: World): any => ({
    userId: w.branchLoginA._id.toString(), businessId: w.business._id.toString(), role: 'branch', kind: 'tenant',
    name: 'b', branchIds: [w.branchA._id.toString()], branchId: w.branchA._id.toString(),
  });

  it('5 parallel bookings of the SAME stylist at the same time -> exactly one succeeds', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        appointmentService.createAppointment(ctx(w), w.branchA._id.toString(), {
          customerId: w.customer._id.toString(), lines: [line(w.haircut, w.stylist1, ist(D(), '11:00'))], source: 'phone',
        })
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await Appointment.countDocuments({ businessId: w.business._id, 'lines.staffId': w.stylist1._id })).toBe(1);
  }, 60000);

  it('YOUR RULE: parallel bookings of DIFFERENT stylists at the same time all succeed', async () => {
    const extra = await Promise.all([1, 2, 3].map((i) => createStaff(w.business._id, w.branchA._id, { name: `P${i}` })));
    const staff = [w.stylist1, w.stylist2, ...extra];
    const results = await Promise.allSettled(
      staff.map((s) =>
        appointmentService.createAppointment(ctx(w), w.branchA._id.toString(), {
          customerId: w.customer._id.toString(), lines: [line(w.haircut, s, ist(D(), '11:00'))], source: 'phone',
        })
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(staff.length);
  }, 60000);
});
