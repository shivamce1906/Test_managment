import '../helpers/testEnv';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, World, serviceLine, ist, dayOffset, createCustomer } from '../helpers/factory';
import { Appointment, Business, Customer, DailySummary, Due, LoyaltyLedger, Notification, StaffBlock } from '../../src/models';
import { getBusinessDate } from '../../src/utils';

const D = () => dayOffset(1);
const line = (svc: any, staff: any, start: string) => ({ serviceId: svc._id.toString(), ...(staff ? { staffId: staff._id.toString() } : {}), start });
const book = (w: World, token: string, lines: any[], branch = w.branchA) =>
  as(token).post(`/branches/${branch._id}/appointments`, { customerId: w.customer._id.toString(), lines });
const bill = (w: World, token: string, extra: any = {}) =>
  as(token).post(`/branches/${w.branchA._id}/bills`, {
    customerId: w.customer._id.toString(),
    billedByStaffId: w.receptionist._id.toString(),
    lines: [serviceLine(w.haircut._id, w.stylist1._id)],
    payments: [{ mode: 'cash', amountPaise: 118000 }],
    ...extra,
  });

describe('Front desk (Phase 2): customers', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('alternate phones are saved normalised; an edited phone is normalised too', async () => {
    const c = await as(w.tokens.owner).post('/customers', { name: 'Asha', phone: '98200 00011', altPhones: ['98200 00012'] });
    expect(c.status).toBe(201);
    expect(c.body.altPhones).toEqual(['+919820000012']);
    const u = await as(w.tokens.owner).patch(`/customers/${c.body._id}`, { phone: '98200 00013' });
    expect(u.body.phone).toBe('+919820000013');
  });

  it('update and note responses are masked for a branch login', async () => {
    const u = await as(w.tokens.branchA).patch(`/customers/${w.customer._id}`, { notes: 'Prefers mornings' });
    expect(u.status).toBe(200);
    expect(u.body.phone).not.toBe(w.customer.phone);
    const n = await as(w.tokens.branchA).post(`/customers/${w.customer._id}/notes`, { text: 'Short layers' });
    expect(n.body.phone).not.toBe(w.customer.phone);
  });

  it('garbage phone numbers are a 400', async () => {
    expect((await as(w.tokens.owner).post('/customers', { name: 'X', phone: 'abcdefghij' })).status).toBe(400);
  });

  it('POST /customers/:id/merge keeps :id and moves the duplicate\'s dues', async () => {
    const dup = await createCustomer(w.business._id, { name: 'Priya S', phone: '+919822222222' });
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: dup._id.toString(), lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 100000 }],
    });
    const r = await as(w.tokens.owner).post(`/customers/${w.customer._id}/merge`, { duplicateId: dup._id.toString() });
    expect(r.status).toBe(200);
    expect(await Due.countDocuments({ businessId: w.business._id, customerId: w.customer._id })).toBe(1);
    expect((await Customer.findOne({ _id: w.customer._id, businessId: w.business._id }))!.duePaise).toBe(18000);
  });

  it('search is plain text; tags filter; history of an unknown customer is a 404', async () => {
    expect((await as(w.tokens.owner).get('/customers?q=.*')).body.total).toBe(0);
    await Customer.updateOne({ _id: w.customer._id, businessId: w.business._id }, { $set: { tags: ['vip'] } });
    expect((await as(w.tokens.owner).get('/customers?tags=vip')).body.total).toBe(1);
    expect((await as(w.tokens.owner).get('/customers/64b000000000000000000000/history')).status).toBe(404);
    expect((await as(w.tokens.owner).get(`/customers/${w.customer._id}/history?type=bills`)).body).toHaveProperty('bills');
  });

  it('export is owner only', async () => {
    expect((await as(w.tokens.manager).get('/customers/export')).status).toBe(403);
  });
});

describe('Front desk (Phase 2): calendar and appointments', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('availability lists free start times per stylist and leaves out booked ones', async () => {
    await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))]);
    const res = await as(w.tokens.branchA).get(`/branches/${w.branchA._id}/availability?serviceId=${w.haircut._id}&date=${D()}&stepMin=30`);
    expect(res.status).toBe(200);
    expect(res.body.durationMin).toBe(30);
    const names = res.body.staff.map((s: any) => s.name);
    expect(names).toContain('Sam Stylist');
    expect(names).not.toContain('Riya Reception');
    const sam = res.body.staff.find((s: any) => s.name === 'Sam Stylist');
    expect(sam.slots).not.toContain('11:00');
    expect(sam.slots).toContain('11:30');
    expect(sam.slots[0]).toBe('10:00');
  });

  it('availability for a holiday is empty', async () => {
    await as(w.tokens.owner).patch(`/business/branches/${w.branchA._id}`, { holidays: [{ date: D(), name: 'Diwali' }] });
    const res = await as(w.tokens.owner).get(`/branches/${w.branchA._id}/availability?serviceId=${w.haircut._id}&date=${D()}`);
    expect(res.body.staff).toEqual([]);
  });

  it('reschedule moves the booking, bumps __v, and a stale __v is a 409', async () => {
    const a = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))]);
    const r = await as(w.tokens.branchA).patch(`/appointments/${a.body._id}`, { lines: [line(w.haircut, w.stylist2, ist(D(), '15:00'))], __v: a.body.__v });
    expect(r.status).toBe(200);
    expect(r.body.lines[0].staffId).toBe(w.stylist2._id.toString());
    expect(r.body.__v).toBe(a.body.__v + 1);
    const stale = await as(w.tokens.branchA).patch(`/appointments/${a.body._id}`, { notes: 'x', __v: a.body.__v });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
  });

  it('rescheduling into its own old slot is not a clash with itself', async () => {
    const a = await book(w, w.tokens.branchA, [line(w.colour, w.stylist1, ist(D(), '11:00'))]);
    const r = await as(w.tokens.branchA).patch(`/appointments/${a.body._id}`, { lines: [line(w.colour, w.stylist1, ist(D(), '11:30'))], __v: a.body.__v });
    expect(r.status).toBe(200);
  });

  it('calendar returns appointments with customer names, bookable staff, rosters and blocks', async () => {
    await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))]);
    await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/staff-blocks`, { staffId: w.stylist2._id.toString(), start: ist(D(), '13:00'), end: ist(D(), '14:00'), reason: 'Lunch' });
    const res = await as(w.tokens.branchA).get(`/branches/${w.branchA._id}/appointments?from=${D()}`);
    expect(res.status).toBe(200);
    expect(res.body.appointments[0].customerId.name).toBe('Priya Shah');
    expect(res.body.appointments[0].customerId.phone).not.toBe(w.customer.phone);
    expect(res.body.staff.map((s: any) => s.name).sort()).toEqual(['Sam Stylist', 'Tara Stylist']);
    expect(res.body.staffBlocks).toHaveLength(1);
    expect(Array.isArray(res.body.rosters)).toBe(true);
  });

  it('a range longer than 31 days is a 400', async () => {
    expect((await as(w.tokens.owner).get(`/branches/${w.branchA._id}/appointments?from=2026-01-01&to=2026-03-01`)).status).toBe(400);
  });

  it('branch login B cannot open or reschedule a branch A appointment', async () => {
    const a = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))]);
    expect((await as(w.tokens.branchB).get(`/appointments/${a.body._id}`)).status).toBe(404);
    expect((await as(w.tokens.branchB).patch(`/appointments/${a.body._id}`, { notes: 'x', __v: 0 })).status).toBe(404);
  });

  it('staff block: staff must be in the branch; deleting an unknown block is a 404', async () => {
    const bad = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/staff-blocks`, { staffId: w.stylistB._id.toString(), start: ist(D(), '13:00'), end: ist(D(), '14:00'), reason: 'x' });
    expect(bad.status).toBe(404);
    expect((await as(w.tokens.owner).delete(`/branches/${w.branchA._id}/staff-blocks/64b000000000000000000000`)).status).toBe(404);
    const ok = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/staff-blocks`, { staffId: w.stylist1._id.toString(), start: ist(D(), '13:00'), end: ist(D(), '14:00'), reason: 'Lunch' });
    expect((await as(w.tokens.owner).delete(`/branches/${w.branchA._id}/staff-blocks/${ok.body._id}`)).status).toBe(200);
    expect(await StaffBlock.countDocuments({ businessId: w.business._id })).toBe(0);
  });

  it('SRS paths work: POST /appointments/:id/status and /appointments/walk-in', async () => {
    const a = await book(w, w.tokens.branchA, [line(w.haircut, w.stylist1, ist(D(), '11:00'))]);
    expect((await as(w.tokens.branchA).post(`/appointments/${a.body._id}/status`, { status: 'confirmed' })).status).toBe(200);
    const walk = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/appointments/walk-in`, { customerId: w.customer._id.toString(), serviceIds: [w.haircut._id.toString()] });
    expect([201, 409]).toContain(walk.status); // 409 only when it is outside opening hours right now
  });

  it('billing an appointment moves it to billed; cancelling the bill moves it back to completed', async () => {
    const today = getBusinessDate();
    const a = await Appointment.create({
      businessId: w.business._id, branchId: w.branchA._id, customerId: w.customer._id, businessDate: today,
      lines: [{ serviceId: w.haircut._id, serviceName: 'Haircut', staffId: w.stylist1._id, start: new Date(), end: new Date(Date.now() + 1800000) }],
      start: new Date(), end: new Date(Date.now() + 1800000), status: 'completed', statusLog: [], source: 'phone',
    });
    const b = await bill(w, w.tokens.branchA, { appointmentId: a._id.toString() });
    expect(b.status).toBe(201);
    expect((await Appointment.findOne({ _id: a._id, businessId: w.business._id }))!.status).toBe('billed');
    expect((await bill(w, w.tokens.branchA, { appointmentId: a._id.toString() })).status).toBe(422);
    await as(w.tokens.manager).post(`/bills/${b.body._id}/cancel`, { reason: 'Wrong customer' });
    expect((await Appointment.findOne({ _id: a._id, businessId: w.business._id }))!.status).toBe('completed');
  });
});

describe('Front desk (Phase 2): billing', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('invoice PDF: A4 and thermal are real PDFs; another branch\'s login gets 404', async () => {
    const b = await bill(w, w.tokens.branchA);
    const a4 = await as(w.tokens.branchA).get(`/bills/${b.body._id}/pdf`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(a4.status).toBe(200);
    expect(a4.headers['content-type']).toBe('application/pdf');
    expect((a4.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const thermal = await as(w.tokens.owner).get(`/bills/${b.body._id}/pdf?format=thermal`);
    expect(thermal.status).toBe(200);
    expect((await as(w.tokens.branchB).get(`/bills/${b.body._id}/pdf`)).status).toBe(404);
  });

  it('preview needs no customer and reports what is payable', async () => {
    const r = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills/preview`, { lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 999999 }] });
    expect(r.status).toBe(200);
    expect(r.body.payablePaise).toBe(118000);
    expect(r.body.lines[0].staff[0].name).toBe('Sam Stylist');
  });

  it('loyalty redemption is valued by the server (points × redeemValuePaise), not by the client', async () => {
    await Customer.updateOne({ _id: w.customer._id, businessId: w.business._id }, { $set: { loyaltyPoints: 50 } });
    const r = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills/preview`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylist1._id)],
      redemptions: [{ kind: 'loyalty', refId: w.customer._id.toString(), points: 20, amountPaise: 9999999 }],
    });
    expect(r.status).toBe(200);
    expect(r.body.redemptions[0].amountPaise).toBe(2000);
  });

  it('an earned point balance is reversed when the bill is cancelled', async () => {
    const b = await bill(w, w.tokens.branchA);
    expect((await Customer.findOne({ _id: w.customer._id, businessId: w.business._id }))!.loyaltyPoints).toBe(11);
    await as(w.tokens.manager).post(`/bills/${b.body._id}/cancel`, { reason: 'x' });
    expect((await Customer.findOne({ _id: w.customer._id, businessId: w.business._id }))!.loyaltyPoints).toBe(0);
    expect(await LoyaltyLedger.countDocuments({ businessId: w.business._id, type: 'reverse' })).toBe(1);
  });

  it('owner is notified when a discount is above ownerAlertBps', async () => {
    await Business.updateOne({ _id: w.business._id }, { $set: { 'discountLimits.ownerAlertBps': 500, 'discountLimits.branchBps': 1000 } });
    await bill(w, w.tokens.branchA, { billDiscount: { type: 'pct', value: 800 }, payments: [{ mode: 'cash', amountPaise: 108560 }] });
    const n = await Notification.findOne({ businessId: w.business._id, userId: w.owner._id, type: 'bill.discount_alert' });
    expect(n).toBeTruthy();
  });

  it('a due receipt adds its money to the day\'s collections', async () => {
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 100000 }],
    });
    const rc = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/due-receipts`, { customerId: w.customer._id.toString(), payments: [{ mode: 'upi', amountPaise: 18000 }] });
    expect(rc.status).toBe(201);
    const s: any = await DailySummary.findById(`${w.branchA._id}:${getBusinessDate()}`).lean();
    expect(s.collections.upi).toBe(18000);
  });

  it('collecting an old due on a new bill works when it is fully paid', async () => {
    const first = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 100000 }],
    });
    const due = await Due.findOne({ businessId: w.business._id, billId: first.body._id });
    const second = await bill(w, w.tokens.branchA, { collectDues: [{ dueId: due!._id.toString(), amountPaise: 18000 }], payments: [{ mode: 'cash', amountPaise: 136000 }] });
    expect(second.status).toBe(201);
    expect(second.body.totals.duePaise).toBe(0);
    expect((await Due.findOne({ _id: due!._id, businessId: w.business._id }))!.status).toBe('settled');
  });

  it('edit with payments left out keeps the old payments; refund then returns the excess', async () => {
    const b = (await bill(w, w.tokens.branchA)).body;
    const e = await as(w.tokens.owner).patch(`/bills/${b._id}`, {
      lines: [{ kind: 'product', refId: w.retail._id.toString(), qty: 1 }], reason: 'Wrong item', __v: b.__v,
    });
    expect(e.status).toBe(200);
    expect(e.body.payments).toHaveLength(1);
    expect(e.body.totals.totalPaise).toBe(59000);
    const r = await as(w.tokens.owner).post(`/bills/${b._id}/refund`, { amountPaise: 59000, mode: 'cash', reason: 'Excess after edit' });
    expect(r.status).toBe(200);
  });

  it('a manager cannot edit a bill to a discount above their limit', async () => {
    const b = (await bill(w, w.tokens.branchA)).body;
    const e = await as(w.tokens.manager).patch(`/bills/${b._id}`, {
      lines: [serviceLine(w.haircut._id, w.stylist1._id)], billDiscount: { type: 'pct', value: 5000 }, reason: 'x', __v: b.__v,
    });
    expect(e.status).toBe(422);
    expect(e.body.error.code).toBe('DISCOUNT_LIMIT');
  });

  it('bills list searches invoice numbers and filters by date range', async () => {
    const b = (await bill(w, w.tokens.branchA)).body;
    const tail = b.invoiceNo.slice(-6);
    const res = await as(w.tokens.owner).get(`/branches/${w.branchA._id}/bills?q=${tail}&from=${getBusinessDate()}&to=${getBusinessDate()}`);
    expect(res.body.total).toBe(1);
    expect((await as(w.tokens.owner).get(`/branches/${w.branchA._id}/bills?status=lost`)).status).toBe(400);
  });

  it('a manager only sees approvals of their branches, even when asking for another branch', async () => {
    const res = await as(w.tokens.manager).get(`/approvals?branchId=${w.branchB._id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('rejecting needs a reason', async () => {
    const b = (await bill(w, w.tokens.branchA, { billDiscount: { type: 'pct', value: 5000 }, payments: [{ mode: 'cash', amountPaise: 59000 }] })).body;
    expect((await as(w.tokens.manager).post(`/bills/${b._id}/decide`, { decision: 'reject' })).status).toBe(400);
  });
});
