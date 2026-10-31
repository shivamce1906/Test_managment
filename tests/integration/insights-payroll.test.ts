import '../helpers/testEnv';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, World, serviceLine, createPlan } from '../helpers/factory';
import { Business, Leave, PayrollRun, Staff } from '../../src/models';
import * as payroll from '../../src/services/payroll.service';
import { getBusinessDate, getDaysInMonth } from '../../src/utils';

const TODAY = () => getBusinessDate();
const MONTH = () => TODAY().slice(0, 7);
const bill = (w: World, branch: any, staff: any, extra: any = {}) =>
  as(w.tokens.owner).post(`/branches/${branch._id}/bills`, {
    customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, staff._id)], payments: [{ mode: 'cash', amountPaise: 118000 }], ...extra,
  });
const binary = (r: any) => r.buffer(true).parse((res: any, cb: any) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

describe('Phase 4: dashboard', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('shows collections, approvals, dues, the 7-day trend and top services', async () => {
    await bill(w, w.branchA, w.stylist1);
    await bill(w, w.branchA, w.stylist1, { payments: [{ mode: 'upi', amountPaise: 100000 }] }); // part paid -> due
    await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), billedByStaffId: w.receptionist._id.toString(),
      lines: [serviceLine(w.haircut._id, w.stylist1._id)], billDiscount: { type: 'pct', value: 5000 }, payments: [{ mode: 'cash', amountPaise: 59000 }],
    }); // held for approval
    const d = await as(w.tokens.owner).get('/dashboard');
    expect(d.status).toBe(200);
    expect(d.body.today).toMatchObject({ billsCount: 2, salesPaise: 200000, collections: { cash: 118000, upi: 100000, card: 0, wallet: 0 } });
    expect(d.body.pendingApprovalsCount).toBe(1);
    expect(d.body.openDuesPaise).toBe(18000);
    expect(d.body.last7Days).toHaveLength(7);
    expect(d.body.last7Days[6]).toMatchObject({ date: TODAY(), billsCount: 2 });
    expect(d.body.topServicesToday[0]).toMatchObject({ name: 'Haircut', count: 2 });
  });

  it('a branch login sees only its branch; another branch id is a 403 for a manager', async () => {
    await bill(w, w.branchA, w.stylist1);
    await bill(w, w.branchB, w.stylistB);
    expect((await as(w.tokens.branchB).get('/dashboard')).body.today.billsCount).toBe(1);
    expect((await as(w.tokens.manager).get(`/dashboard?branchId=${w.branchB._id}`)).status).toBe(403);
  });
});

describe('Phase 4: reports', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });
  const q = `from=${getBusinessDate()}&to=${getBusinessDate()}`;

  it('sales summary has daily rows and totals including collections and dues collected', async () => {
    await bill(w, w.branchA, w.stylist1, { payments: [{ mode: 'cash', amountPaise: 100000 }] });
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/due-receipts`, { customerId: w.customer._id.toString(), payments: [{ mode: 'upi', amountPaise: 18000 }] });
    const r = await as(w.tokens.owner).get(`/reports/sales-summary?${q}`);
    expect(r.body.rows).toHaveLength(1);
    expect(r.body.summary).toMatchObject({ bills: 1, netPaise: 100000, cashPaise: 100000, upiPaise: 18000, duesCollectedPaise: 18000 });
  });

  it('service profitability subtracts commission and consumable cost', async () => {
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.colour._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 295000 }],
    });
    const r = await as(w.tokens.owner).get(`/reports/service-profitability?${q}`);
    // ₹2,500 net, 10% stylist default commission = ₹250, 30 ml colour = ₹150
    expect(r.body.rows[0]).toMatchObject({ name: 'Global Colour', count: 1, netPaise: 250000, commissionPaise: 25000, consumableCostPaise: 15000, marginPaise: 210000 });
  });

  it('staff performance credits the split share, commission and tips', async () => {
    await bill(w, w.branchA, w.stylist1, { tips: [{ staffId: w.stylist1._id.toString(), amountPaise: 5000, payout: 'cash_today' }], payments: [{ mode: 'cash', amountPaise: 123000 }] });
    const r = await as(w.tokens.owner).get(`/reports/staff-performance?branchId=${w.branchA._id}&${q}`);
    const sam = r.body.rows.find((x: any) => x.name === 'Sam Stylist');
    expect(sam).toMatchObject({ services: 1, serviceSalesPaise: 100000, commissionPaise: 10000, tipsPaise: 5000 });
  });

  it('membership liability values unused package sessions', async () => {
    const plan = await createPlan(w.business._id, { type: 'package', name: 'P', pricePaise: 300000, validityDays: 30, package: { items: [{ serviceId: w.haircut._id, sessions: 3 }] } });
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, { customerId: w.customer._id.toString(), lines: [{ kind: 'package', refId: plan._id.toString() }], payments: [{ mode: 'cash', amountPaise: 354000 }] });
    const r = await as(w.tokens.owner).get('/reports/membership-liability');
    expect(r.body.rows.find((x: any) => x.type === 'package')).toMatchObject({ count: 1, unusedSessions: 3, liabilityPaise: 300000 });
  });

  it('inventory valuation uses the cost per use unit (₹500 per 100 ml tube -> 500 ml = ₹2,500)', async () => {
    const r = await as(w.tokens.owner).get(`/reports/inventory-valuation?branchId=${w.branchA._id}`);
    expect(r.body.rows.find((x: any) => x.name === 'Colour Tube')).toMatchObject({ qty: 500, unitCostPaise: 500, valuePaise: 250000 });
    expect(r.body.summary.consumablePaise).toBe(250000);
  });

  it('expenses P&L: revenue − product cost − consumables − commission − expenses', async () => {
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [{ kind: 'product', refId: w.retail._id.toString(), qty: 1 }], payments: [{ mode: 'cash', amountPaise: 59000 }],
    });
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/expenses`, { category: 'tea_snacks', amountPaise: 10000, mode: 'cash', paidFrom: 'till' });
    const r = await as(w.tokens.owner).get(`/reports/expenses-pnl?branchId=${w.branchA._id}&${q}`);
    expect(r.body.summary).toMatchObject({ revenuePaise: 50000, productCostPaise: 30000, expensesPaise: 10000, netProfitPaise: 10000 });
  });

  it('GSTR-1 has the HSN/SAC summary; customer retention counts first-time customers', async () => {
    await bill(w, w.branchA, w.stylist1);
    const g = await as(w.tokens.owner).get(`/reports/gstr-1?${q}`);
    expect(g.body.hsn[0]).toMatchObject({ hsnSac: '9983', ratePct: 18, qty: 1, taxablePaise: 100000, cgstPaise: 9000, sgstPaise: 9000 });
    const c = await as(w.tokens.owner).get(`/reports/customer-retention?${q}`);
    expect(c.body.summary).toMatchObject({ customers: 1, newCustomers: 1, returningCustomers: 0 });
  });

  it('discounts & cancellations lists both; the Excel export has a sheet for each', async () => {
    const b = await bill(w, w.branchA, w.stylist1, { billDiscount: { type: 'pct', value: 1000 }, payments: [{ mode: 'cash', amountPaise: 106200 }] });
    const c = await bill(w, w.branchA, w.stylist1);
    await as(w.tokens.owner).post(`/bills/${c.body._id}/cancel`, { reason: 'Duplicate' });
    const r = await as(w.tokens.owner).get(`/reports/discounts-cancellations?${q}`);
    expect(r.body.summary).toMatchObject({ discountedBills: 1, discountPaise: 10000, cancelledBills: 1 });
    expect(r.body.rows[0].invoiceNo).toBe(b.body.invoiceNo);
    const x = await binary(as(w.tokens.owner).get(`/reports/discounts-cancellations/export?${q}`));
    expect(x.status).toBe(200);
    expect(x.headers['content-disposition']).toContain('discounts-cancellations_');
    expect((x.body as Buffer).subarray(0, 2).toString()).toBe('PK'); // xlsx is a zip
  });

  it('a range over 366 days is a 400; an unknown report is a 404', async () => {
    expect((await as(w.tokens.owner).get('/reports/sales-summary?from=2024-01-01&to=2026-01-01')).status).toBe(400);
    expect((await as(w.tokens.owner).get('/reports/nope')).status).toBe(404);
  });
});

describe('Phase 4: payroll', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });
  const ownerCtx = (w: World): any => ({ userId: w.owner._id.toString(), businessId: w.business._id.toString(), role: 'owner', kind: 'tenant', name: 'o', branchIds: [] });
  const create = (w: World) => as(w.tokens.owner).post(`/branches/${w.branchA._id}/payroll-runs`, { month: MONTH() });
  const lineOf = (r: any, staffId: any) => r.lines.find((l: any) => String(l.staffId) === String(staffId));

  it('approved unpaid leave reduces paid days; days without attendance count as worked', async () => {
    await Leave.create({ businessId: w.business._id, branchId: w.branchA._id, staffId: w.stylist1._id, from: `${MONTH()}-01`, to: `${MONTH()}-02`, type: 'unpaid', status: 'approved' });
    const r = await create(w);
    expect(r.status).toBe(201);
    const days = getDaysInMonth(MONTH());
    expect(lineOf(r.body, w.stylist1._id)).toMatchObject({ paidDays: days - 2, salaryPaise: Math.round((3000000 * (days - 2)) / days) });
  });

  it('a staff member who joined mid-month is paid from their joining date', async () => {
    await Staff.updateOne({ _id: w.stylist2._id, businessId: w.business._id }, { $set: { joiningDate: `${MONTH()}-11` } });
    const r = await create(w);
    const days = getDaysInMonth(MONTH());
    expect(lineOf(r.body, w.stylist2._id).paidDays).toBe(days - 10);
  });

  it('ESI below the wage ceiling and PT from the business slabs', async () => {
    await Business.updateOne({ _id: w.business._id }, { $set: {
      'payroll.esi': { enabled: true, employeePct: 0.75, wageCeilingPaise: 5000000 },
      'payroll.pt': { enabled: true, slabs: [{ uptoPaise: 1000000, amountPaise: 0 }, { uptoPaise: 99999999, amountPaise: 20000 }] },
    } });
    await Staff.updateOne({ _id: w.stylist1._id, businessId: w.business._id }, { $set: { 'statutory.esi': true, 'statutory.pt': true } });
    const r = await create(w);
    expect(lineOf(r.body, w.stylist1._id)).toMatchObject({ esiPaise: 22500, ptPaise: 20000 }); // 0.75% of ₹30,000; ₹200 slab
  });

  it('run totals carry gross and deductions; adjusting below zero is a 422', async () => {
    const r = await create(w);
    expect(r.body.totals.netPaise).toBe(r.body.totals.grossPaise - r.body.totals.deductionsPaise);
    const adj = await as(w.tokens.owner).patch(`/payroll-runs/${r.body._id}/adjust-line`, { staffId: w.stylist1._id.toString(), field: 'commissionPaise', deltaPaise: -999999, reason: 'x' });
    expect(adj.status).toBe(422);
    expect((await as(w.tokens.owner).patch(`/payroll-runs/${r.body._id}/adjust-line`, { staffId: w.stylist1._id.toString(), field: 'name', deltaPaise: 1, reason: 'x' })).status).toBe(400);
  });

  it('payslips: not for drafts; real PDFs once reviewed; download per staff member', async () => {
    const r = await create(w);
    expect((await as(w.tokens.owner).post(`/payroll-runs/${r.body._id}/payslips`)).status).toBe(422);
    await as(w.tokens.owner).post(`/payroll-runs/${r.body._id}/review`);
    const gen = await as(w.tokens.owner).post(`/payroll-runs/${r.body._id}/payslips`);
    expect(gen.status).toBe(200);
    expect(gen.body.length).toBe(r.body.lines.length);
    const pdf = await binary(as(w.tokens.owner).get(gen.body[0].downloadPath));
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('mark paid for some staff keeps the run locked until everyone is paid', async () => {
    const r = await create(w);
    await as(w.tokens.owner).post(`/payroll-runs/${r.body._id}/lock`);
    const one = await as(w.tokens.owner).post(`/payroll-runs/${r.body._id}/mark-paid`, { staffIds: [w.stylist1._id.toString()], mode: 'upi', date: TODAY() });
    expect(one.body.status).toBe('locked');
    expect(lineOf(one.body, w.stylist1._id).paid).toMatchObject({ mode: 'upi', date: TODAY() });
    const rest = await as(w.tokens.owner).post(`/payroll-runs/${r.body._id}/mark-paid`, { mode: 'bank', date: TODAY() });
    expect(rest.body.status).toBe('paid');
  });

  it('a manager cannot open another branch\'s run; future months and locked months cannot be (re)generated', async () => {
    const other: any = await payroll.createMonthlyRun(ownerCtx(w), w.branchB._id.toString(), { month: MONTH() });
    expect((await as(w.tokens.manager).get(`/payroll-runs/${other._id}`)).status).toBe(404);
    const next = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 7);
    expect((await as(w.tokens.owner).post(`/branches/${w.branchA._id}/payroll-runs`, { month: next })).status).toBe(422);
    const r = await create(w);
    await as(w.tokens.owner).post(`/payroll-runs/${r.body._id}/lock`);
    const again = await create(w);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PAYROLL_LOCKED');
  });

  it('a bill in a locked month cannot be edited', async () => {
    const b = await bill(w, w.branchA, w.stylist1);
    const r = await create(w);
    await as(w.tokens.owner).post(`/payroll-runs/${r.body._id}/lock`);
    const e = await as(w.tokens.owner).patch(`/bills/${b.body._id}`, { lines: [serviceLine(w.haircut._id, w.stylist1._id)], reason: 'x', __v: b.body.__v });
    expect(e.status).toBe(409);
    expect(e.body.error.code).toBe('PAYROLL_LOCKED');
    expect((await as(w.tokens.owner).post(`/bills/${b.body._id}/refund`, { amountPaise: 1000, mode: 'cash', reason: 'goodwill' })).status).toBe(200);
  });

  it('attendance changed after the draft makes the lock stale', async () => {
    const r = await create(w);
    await as(w.tokens.owner).post(`/staff/branches/${w.branchA._id}/attendance?date=${TODAY()}`, { entries: [{ staffId: w.stylist1._id.toString(), status: 'absent' }] });
    const lk = await as(w.tokens.owner).post(`/payroll-runs/${r.body._id}/lock`);
    expect(lk.status).toBe(409);
    expect(lk.body.error.code).toBe('PAYROLL_STALE');
    expect(await PayrollRun.countDocuments({ businessId: w.business._id, status: 'locked' })).toBe(0);
  });
});
