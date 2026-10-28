import '../helpers/testEnv';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, World, serviceLine, createStaff, createRoster, dayOffset } from '../helpers/factory';
import { Attendance, Staff, Business, Bill, PayrollRun, Advance, AuditLog } from '../../src/models';
import { getBusinessDate, getBusinessMonth, getIstDayOfWeek, parseIstDateTime, getDaysInMonth } from '../../src/utils';
import * as payroll from '../../src/services/payroll.service';

const MONTH = () => getBusinessMonth();
const att = (w: World, token: string, entries: any[], extra: any = {}) =>
  as(token).post(`/staff/branches/${w.branchA._id}/attendance${extra.date ? `?date=${extra.date}` : ''}`, { entries, ...(extra.reason ? { reason: extra.reason } : {}) });

describe('Staff records', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('owner creates a staff member with normalised phone', async () => {
    const res = await as(w.tokens.owner).post('/staff', {
      branchId: w.branchA._id.toString(), name: 'Kiran', phone: '98123 45678', designation: 'senior_stylist', joiningDate: '2026-01-01',
      salary: { type: 'monthly', amountPaise: 2500000 }, commission: { service: { type: 'pct', value: 1200 } },
    });
    expect(res.status).toBe(201);
    expect(res.body.phone).toBe('+919812345678');
  });

  it('cannot create staff in another business\'s branch', async () => {
    const res = await as(w.tokens.owner).post('/staff', {
      branchId: w.otherBranch._id.toString(), name: 'X', phone: '9812345678', designation: 'stylist', joiningDate: '2026-01-01', salary: { type: 'monthly', amountPaise: 0 },
    });
    expect([403, 404]).toContain(res.status);
  });

  it('bank account is stored as last-4 only', async () => {
    const res = await as(w.tokens.owner).post('/staff', {
      branchId: w.branchA._id.toString(), name: 'Y', phone: '9812345678', designation: 'stylist', joiningDate: '2026-01-01',
      salary: { type: 'monthly', amountPaise: 0 }, bankRef: { bank: 'HDFC', last4: '123456' },
    });
    expect(res.status).toBe(400);
  });

  it('billed-by list shows only active receptionists of the branch', async () => {
    const res = await as(w.tokens.owner).get(`/staff/branches/${w.branchA._id}/billed-by`);
    expect(res.status).toBe(200);
    expect(res.body.map((s: any) => s.name)).toEqual(['Riya Reception']);
  });

  it('exiting a staff member keeps the record (status exited)', async () => {
    const res = await as(w.tokens.owner).patch(`/staff/${w.stylist2._id}`, { status: 'exited', exitDate: dayOffset(0), exitReason: 'Moved city' });
    expect(res.status).toBe(200);
    expect((await Staff.findOne({ _id: w.stylist2._id, businessId: w.business._id }))!.status).toBe('exited');
  });

  it('roster: weekly template + override saved', async () => {
    const res = await as(w.tokens.owner).patch(`/staff/${w.stylist1._id}/roster`, {
      weekly: [{ day: 2, off: true }, { day: 3, start: '10:00', end: '20:00', off: false }],
      overrides: [{ date: dayOffset(3), off: true }],
    });
    expect(res.status).toBe(200);
    const r = await as(w.tokens.owner).get(`/staff/${w.stylist1._id}/roster`);
    expect(r.body.overrides).toHaveLength(1);
  });

  it('roster with start after end -> 400', async () => {
    const res = await as(w.tokens.owner).patch(`/staff/${w.stylist1._id}/roster`, { weekly: [{ day: 3, start: '20:00', end: '10:00', off: false }] });
    expect(res.status).toBe(400);
  });
});

describe('Attendance', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('owner marks today\'s attendance with clock-in/out', async () => {
    const d = getBusinessDate();
    const res = await att(w, w.tokens.owner, [{ staffId: w.stylist1._id.toString(), status: 'present', inAt: parseIstDateTime(d, '10:00').toISOString(), outAt: parseIstDateTime(d, '19:00').toISOString() }], { date: d });
    expect(res.status).toBe(200);
    const rec = await Attendance.findOne({ businessId: w.business._id, staffId: w.stylist1._id });
    expect(rec?.businessDate).toBe(d);
    expect(rec?.status).toBe('present');
  });

  it('marking again the same day updates, never duplicates', async () => {
    const d = getBusinessDate();
    await att(w, w.tokens.owner, [{ staffId: w.stylist1._id.toString(), status: 'present' }], { date: d });
    await att(w, w.tokens.owner, [{ staffId: w.stylist1._id.toString(), status: 'late' }], { date: d });
    expect(await Attendance.countDocuments({ businessId: w.business._id, staffId: w.stylist1._id, businessDate: d })).toBe(1);
  });

  it('past-date edit needs a reason, which is logged on the record', async () => {
    const y = dayOffset(-1);
    expect((await att(w, w.tokens.owner, [{ staffId: w.stylist1._id.toString(), status: 'absent' }], { date: y })).status).toBe(400);
    expect((await att(w, w.tokens.owner, [{ staffId: w.stylist1._id.toString(), status: 'absent' }], { date: y, reason: 'Forgot yesterday' })).status).toBe(200);
    const rec = await Attendance.findOne({ businessId: w.business._id, staffId: w.stylist1._id, businessDate: y });
    expect(rec!.edits[0].reason).toBe('Forgot yesterday');
  });

  it('attendance marking is audited', async () => {
    await att(w, w.tokens.owner, [{ staffId: w.stylist1._id.toString(), status: 'present' }], { date: getBusinessDate() });
    expect(await AuditLog.findOne({ businessId: w.business._id, action: 'attendance.marked' })).toBeTruthy();
  });

  it('cannot mark attendance for staff of another branch through this branch', async () => {
    const res = await att(w, w.tokens.owner, [{ staffId: w.stylistB._id.toString(), status: 'present' }], { date: getBusinessDate() });
    expect([403, 404, 422]).toContain(res.status);
  });

  it('cannot mark attendance for another business\'s staff', async () => {
    const foreign = await createStaff(w.otherBusiness._id, w.otherBranch._id);
    const res = await att(w, w.tokens.owner, [{ staffId: foreign._id.toString(), status: 'present' }], { date: getBusinessDate() });
    expect([403, 404, 422]).toContain(res.status);
  });

  it('clock-out before clock-in -> 400', async () => {
    const d = getBusinessDate();
    const res = await att(w, w.tokens.owner, [{ staffId: w.stylist1._id.toString(), status: 'present', inAt: parseIstDateTime(d, '19:00').toISOString(), outAt: parseIstDateTime(d, '10:00').toISOString() }], { date: d });
    expect(res.status).toBe(400);
  });

  it('overtime is measured beyond the ROSTERED shift (PRD §9), not a fixed 9 hours', async () => {
    const d = getBusinessDate();
    const dow = getIstDayOfWeek(parseIstDateTime(d, '12:00'));
    await createRoster(w, w.stylist1._id, [{ day: dow, start: '10:00', end: '14:00', off: false }]);
    await att(w, w.tokens.owner, [{ staffId: w.stylist1._id.toString(), status: 'present', inAt: parseIstDateTime(d, '10:00').toISOString(), outAt: parseIstDateTime(d, '16:00').toISOString() }], { date: d });
    const rec = await Attendance.findOne({ businessId: w.business._id, staffId: w.stylist1._id });
    expect(rec!.overtimeMin).toBe(120);
  });

  it('EDGE: with no date given, attendance at 01:30 IST goes to the IST day, not the UTC day', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-28T20:00:00.000Z'), doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'clearImmediate', 'queueMicrotask', 'hrtime', 'performance'] });
    try {
      const res = await att(w, w.tokens.owner, [{ staffId: w.stylist1._id.toString(), status: 'present' }]);
      expect(res.status).toBe(200);
      const rec = await Attendance.findOne({ businessId: w.business._id, staffId: w.stylist1._id });
      expect(rec?.businessDate).toBe('2026-10-29');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('Leaves and advances', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('leave request -> approve -> blocks booking', async () => {
    const d = dayOffset(2);
    const l = await as(w.tokens.owner).post(`/staff/branches/${w.branchA._id}/leaves`, { staffId: w.stylist1._id.toString(), from: d, to: d, type: 'paid', reason: 'Wedding' });
    expect(l.status).toBe(201);
    const ap = await as(w.tokens.manager).patch(`/staff/leaves/${l.body._id}/status`, { status: 'approved' });
    expect(ap.status).toBe(200);
    const b = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/appointments`, {
      customerId: w.customer._id.toString(), lines: [{ serviceId: w.haircut._id.toString(), staffId: w.stylist1._id.toString(), start: parseIstDateTime(d, '11:00').toISOString() }],
    });
    expect(b.status).toBe(409);
  });

  it('leave with to < from -> 400', async () => {
    const res = await as(w.tokens.owner).post(`/staff/branches/${w.branchA._id}/leaves`, { staffId: w.stylist1._id.toString(), from: dayOffset(5), to: dayOffset(2), type: 'paid' });
    expect(res.status).toBe(400);
  });

  it('branch login can only view leave, not request it (PRD: Roster and leave = View)', async () => {
    const res = await as(w.tokens.branchA).post(`/staff/branches/${w.branchA._id}/leaves`, { staffId: w.stylist1._id.toString(), from: dayOffset(1), to: dayOffset(1), type: 'paid' });
    expect(res.status).toBe(403);
  });

  it('salary advance is recorded open with recovery per month', async () => {
    const res = await as(w.tokens.owner).post(`/staff/branches/${w.branchA._id}/advances`, {
      staffId: w.stylist1._id.toString(), amountPaise: 500000, date: dayOffset(0), recoveryPerMonthPaise: 250000,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'open', recoveredPaise: 0 });
  });

  it('advance paid from the till creates a till expense', async () => {
    const res = await as(w.tokens.owner).post(`/staff/branches/${w.branchA._id}/advances`, {
      staffId: w.stylist1._id.toString(), amountPaise: 500000, date: dayOffset(0), recoveryPerMonthPaise: 250000, payFromTill: true,
    });
    expect(res.body.expenseId).toBeTruthy();
  });
});

describe('Payroll (PRD §9)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  // The HTTP create endpoint is broken (see first test); drafts are created via the service so the
  // calculation rules can still be tested. Every other step goes through the real HTTP routes.
  const ownerCtx = (w: World): any => ({ userId: w.owner._id.toString(), businessId: w.business._id.toString(), role: 'owner', kind: 'tenant', name: 'o', branchIds: [] });
  const run = async (w: World) => {
    try {
      const doc: any = await payroll.createMonthlyRun(ownerCtx(w), w.branchA._id.toString(), { month: MONTH() });
      return { status: 201, body: JSON.parse(JSON.stringify(doc)) };
    } catch (e: any) {
      return { status: e.statusCode || 500, body: { error: { code: e.code, message: e.message } } };
    }
  };

  it('API: POST /branches/:id/payroll-runs creates a draft run', async () => {
    const res = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/payroll-runs`, { month: MONTH() });
    expect(res.status).toBe(201);
  });

  it('API: mark-paid on a locked run records payment', async () => {
    const r = await run(w);
    await as(w.tokens.owner).post(`/payroll-runs/${r.body._id}/lock`);
    const mp = await as(w.tokens.owner).post(`/payroll-runs/${r.body._id}/mark-paid`, { mode: 'bank', date: dayOffset(0) });
    expect(mp.status).toBe(200);
    expect(mp.body.status).toBe('paid');
  });
  const lineOf = (r: any, staffId: any) => r.lines.find((l: any) => String(l.staffId) === String(staffId));

  async function markMonth(w: World, staffId: any, statuses: string[]) {
    const [y, m] = MONTH().split('-');
    await Attendance.insertMany(statuses.map((s, i) => ({
      businessId: w.business._id, branchId: w.branchA._id, staffId, businessDate: `${y}-${m}-${String(i + 1).padStart(2, '0')}`,
      status: s, overtimeMin: 0, markedBy: w.owner._id,
    })));
  }

  it('draft run: salary prorated by paid days', async () => {
    const days = getDaysInMonth(MONTH());
    await markMonth(w, w.stylist1._id, Array.from({ length: days }, (_, i) => (i < 10 ? 'absent' : 'present')));
    const r = await run(w);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('draft');
    expect(lineOf(r.body, w.stylist1._id).salaryPaise).toBe(Math.round((3000000 * (days - 10)) / days));
  });

  it('half days count as 0.5', async () => {
    const days = getDaysInMonth(MONTH());
    await markMonth(w, w.stylist1._id, Array.from({ length: days }, (_, i) => (i < 2 ? 'half_day' : 'present')));
    const r = await run(w);
    expect(lineOf(r.body, w.stylist1._id).salaryPaise).toBe(Math.round((3000000 * (days - 1)) / days));
  });

  it('commission and payroll tips from this month\'s bills are included; cash tips are not', async () => {
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylist1._id)],
      tips: [{ staffId: w.stylist1._id.toString(), amountPaise: 5000, payout: 'payroll' }, { staffId: w.stylist1._id.toString(), amountPaise: 3000, payout: 'cash_today' }],
      payments: [{ mode: 'cash', amountPaise: 126000 }],
    });
    const r = await run(w);
    const l = lineOf(r.body, w.stylist1._id);
    expect(l.commissionPaise).toBe(10000);
    expect(l.tipsPaise).toBe(5000);
  });

  it('commission of a cancelled bill is reversed', async () => {
    const b = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 118000 }],
    });
    await as(w.tokens.owner).post(`/bills/${b.body._id}/cancel`, { reason: 'x' });
    const r = await run(w);
    expect(lineOf(r.body, w.stylist1._id).commissionPaise).toBe(0);
  });

  it('open advance is deducted up to recovery per month', async () => {
    await Advance.create({ businessId: w.business._id, branchId: w.branchA._id, staffId: w.stylist1._id, amountPaise: 500000, date: dayOffset(0), recoveryPerMonthPaise: 200000, recoveredPaise: 0, status: 'open' });
    const r = await run(w);
    expect(lineOf(r.body, w.stylist1._id).advancePaise).toBe(200000);
  });

  it('PF/ESI/PT are OFF by default even if a staff flag is set, unless the business switches them on', async () => {
    await Staff.updateOne({ _id: w.stylist1._id, businessId: w.business._id }, { $set: { 'statutory.pf': true } });
    const r = await run(w);
    expect(lineOf(r.body, w.stylist1._id).pfPaise).toBe(0);
  });

  it('PF uses the business wage ceiling (12% of ₹15,000 = ₹1,800)', async () => {
    await Business.updateOne({ _id: w.business._id }, { $set: { 'payroll.pf.enabled': true, 'payroll.pf.employeePct': 12, 'payroll.pf.wageCeilingPaise': 1500000 } });
    await Staff.updateOne({ _id: w.stylist1._id, businessId: w.business._id }, { $set: { 'statutory.pf': true } });
    const r = await run(w);
    expect(lineOf(r.body, w.stylist1._id).pfPaise).toBe(180000);
  });

  it('net = earnings - deductions', async () => {
    const r = await run(w);
    const l = lineOf(r.body, w.stylist1._id);
    const earn = l.salaryPaise + l.commissionPaise + l.overtimePaise + l.tipsPaise + (l.incentivesPaise || 0);
    const ded = l.advancePaise + l.pfPaise + l.esiPaise + l.ptPaise + (l.otherDeductionPaise || 0);
    expect(l.netPaise).toBe(earn - ded);
  });

  it('manager adjusts a line with a reason; net and totals update', async () => {
    const r = await run(w);
    const before = lineOf(r.body, w.stylist1._id).netPaise;
    const adj = await as(w.tokens.manager).patch(`/payroll-runs/${r.body._id}/adjust-line`, { staffId: w.stylist1._id.toString(), field: 'incentivesPaise', deltaPaise: 50000, reason: 'Festival bonus' });
    expect(adj.status).toBe(200);
    expect(lineOf(adj.body, w.stylist1._id).netPaise).toBe(before + 50000);
  });

  it('manager cannot lock; owner locks; locked run cannot be adjusted', async () => {
    const r = await run(w);
    expect((await as(w.tokens.manager).post(`/payroll-runs/${r.body._id}/lock`)).status).toBe(403);
    const lk = await as(w.tokens.owner).post(`/payroll-runs/${r.body._id}/lock`);
    expect(lk.status).toBe(200);
    expect(lk.body.status).toBe('locked');
    const adj = await as(w.tokens.owner).patch(`/payroll-runs/${r.body._id}/adjust-line`, { staffId: w.stylist1._id.toString(), field: 'incentivesPaise', deltaPaise: 1, reason: 'x' });
    expect([400, 409, 422]).toContain(adj.status);
  });

  it('a bill added after the draft makes lock fail with 409 PAYROLL_STALE', async () => {
    const r = await run(w);
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 118000 }],
    });
    const lk = await as(w.tokens.owner).post(`/payroll-runs/${r.body._id}/lock`);
    expect(lk.status).toBe(409);
    expect(lk.body.error.code).toBe('PAYROLL_STALE');
  });

  it('after regenerating the stale draft, lock succeeds', async () => {
    await run(w);
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 118000 }],
    });
    const again = await run(w);
    const lk = await as(w.tokens.owner).post(`/payroll-runs/${again.body._id}/lock`);
    expect(lk.status).toBe(200);
  });

  it('lock marks advances recovered', async () => {
    await Advance.create({ businessId: w.business._id, branchId: w.branchA._id, staffId: w.stylist1._id, amountPaise: 200000, date: dayOffset(0), recoveryPerMonthPaise: 200000, recoveredPaise: 0, status: 'open' });
    const r = await run(w);
    await as(w.tokens.owner).post(`/payroll-runs/${r.body._id}/lock`);
    const adv = await Advance.findOne({ businessId: w.business._id, staffId: w.stylist1._id });
    expect(adv).toMatchObject({ recoveredPaise: 200000, status: 'closed' });
  });

  it('bills in a locked payroll month cannot be cancelled (Database Design concurrency rules)', async () => {
    const b = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 118000 }],
    });
    const r = await run(w);
    await as(w.tokens.owner).post(`/payroll-runs/${r.body._id}/lock`);
    const c = await as(w.tokens.owner).post(`/bills/${b.body._id}/cancel`, { reason: 'x' });
    expect([409, 422]).toContain(c.status);
  });

  it('cannot create a second run for a locked month', async () => {
    const r = await run(w);
    await as(w.tokens.owner).post(`/payroll-runs/${r.body._id}/lock`);
    const again = await run(w);
    expect([400, 409]).toContain(again.status);
    expect(await PayrollRun.countDocuments({ businessId: w.business._id, branchId: w.branchA._id, month: MONTH() })).toBe(1);
  });

  it('mark paid requires a locked run', async () => {
    const r = await run(w);
    const mp = await as(w.tokens.owner).post(`/payroll-runs/${r.body._id}/mark-paid`, { mode: 'bank', date: dayOffset(0) });
    expect([400, 422]).toContain(mp.status);
  });

  it('invalid month string -> 400', async () => {
    const r = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/payroll-runs`, { month: '2026-13' });
    expect(r.status).toBe(400);
  });

  it('payroll run of another business is not visible', async () => {
    const r = await run(w);
    expect((await as(w.tokens.otherOwner).get(`/payroll-runs/${r.body._id}`)).status).toBe(404);
  });

  it('service-level: draft for an empty branch has no lines and zero total', async () => {
    const ctx: any = { userId: w.owner._id.toString(), businessId: w.business._id.toString(), role: 'owner', kind: 'tenant', name: 'o', branchIds: [] };
    await Staff.updateMany({ businessId: w.business._id, branchId: w.branchA._id }, { $set: { status: 'exited' } });
    const r: any = await payroll.createMonthlyRun(ctx, w.branchA._id.toString(), { month: MONTH() });
    expect(r.lines).toHaveLength(0);
    expect(r.totals.netPaise).toBe(0);
  });

  it('sanity: bills are untouched by payroll generation', async () => {
    await run(w);
    expect(await Bill.countDocuments({ businessId: w.business._id })).toBe(0);
  });
});
