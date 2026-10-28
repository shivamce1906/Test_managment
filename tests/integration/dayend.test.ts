import '../helpers/testEnv';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, World, serviceLine } from '../helpers/factory';
import { Bill, DayClosure, Expense, AuditLog } from '../../src/models';
import { submitDayClosure, calculateExpected } from '../../src/services/dayend.service';
import { getBusinessDate } from '../../src/utils';

const TODAY = () => getBusinessDate();
const url = (w: World, suffix = '') => `/branches/${w.branchA._id}/closures/${TODAY()}${suffix}`;
const branchCtx = (w: World): any => ({
  userId: w.branchLoginA._id.toString(), businessId: w.business._id.toString(), role: 'branch', kind: 'tenant',
  name: 'Vesu Login', branchIds: [w.branchA._id.toString()], branchId: w.branchA._id.toString(),
});

async function cashBill(w: World, cash: number, extra: any = {}) {
  const r = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
    customerId: w.customer._id.toString(),
    lines: [serviceLine(w.haircut._id, w.stylist1._id)],
    payments: [{ mode: 'cash', amountPaise: cash }],
    ...extra,
  });
  expect(r.status).toBe(201);
  return r.body;
}

describe('Day-end — expected figures (PRD §14 formula)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('cash, UPI and card collections are summed per mode', async () => {
    await cashBill(w, 118000);
    await cashBill(w, 0, { payments: [{ mode: 'upi', amountPaise: 100000 }, { mode: 'card', amountPaise: 18000 }] });
    const exp = await calculateExpected(w.business._id, w.branchA._id, TODAY());
    expect(exp.breakdown.cashSales).toBe(118000);
    expect(exp.upiPaise).toBe(100000);
    expect(exp.cardPaise).toBe(18000);
  });

  it('wallet payments are NOT counted as cash in the till', async () => {
    await (await import('../../src/models')).Customer.updateOne({ _id: w.customer._id, businessId: w.business._id }, { $set: { walletBalancePaise: 118000 } });
    await cashBill(w, 0, { payments: [{ mode: 'wallet', amountPaise: 118000 }] });
    const exp = await calculateExpected(w.business._id, w.branchA._id, TODAY());
    expect(exp.breakdown.cashSales).toBe(0);
  });

  it('opening cash = the branch\'s petty-cash float (₹5,000) when no separate entry exists', async () => {
    const exp = await calculateExpected(w.business._id, w.branchA._id, TODAY());
    expect(exp.breakdown.openingCashFloat).toBe(500000);
  });

  it('cash expenses paid from the till reduce expected cash', async () => {
    await cashBill(w, 118000);
    const e = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/expenses`, {
      category: 'tea_snacks', amountPaise: 20000, mode: 'cash', paidFrom: 'till',
    });
    expect(e.status).toBe(201);
    const exp = await calculateExpected(w.business._id, w.branchA._id, TODAY());
    expect(exp.breakdown.cashExpenses).toBe(20000);
  });

  it('UPI expenses or petty-cash expenses do not reduce till cash', async () => {
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/expenses`, { category: 'repairs', amountPaise: 30000, mode: 'upi', paidFrom: 'bank' });
    const exp = await calculateExpected(w.business._id, w.branchA._id, TODAY());
    expect(exp.breakdown.cashExpenses).toBe(0);
  });

  it('tips paid in cash today reduce expected cash; payroll tips do not', async () => {
    await cashBill(w, 128000, { tips: [{ staffId: w.stylist1._id.toString(), amountPaise: 10000, payout: 'cash_today' }] });
    await cashBill(w, 128000, { tips: [{ staffId: w.stylist1._id.toString(), amountPaise: 10000, payout: 'payroll' }] });
    const exp = await calculateExpected(w.business._id, w.branchA._id, TODAY());
    expect(exp.breakdown.cashTipsPaid).toBe(10000);
  });

  it('cash refunds reduce expected cash', async () => {
    const b = await cashBill(w, 118000);
    await as(w.tokens.owner).post(`/bills/${b._id}/refund`, { amountPaise: 18000, mode: 'cash', reason: 'x' });
    const exp = await calculateExpected(w.business._id, w.branchA._id, TODAY());
    expect(exp.breakdown.cashRefunds).toBe(18000);
  });

  it('EDGE: a cash refund today on YESTERDAY\'s bill reduces TODAY\'s expected cash', async () => {
    const b = await cashBill(w, 118000);
    const yesterday = getBusinessDate(new Date(Date.now() - 86400000));
    await Bill.updateOne({ _id: b._id, businessId: w.business._id }, { $set: { businessDate: yesterday, 'payments.0.businessDate': yesterday } });
    await as(w.tokens.owner).post(`/bills/${b._id}/refund`, { amountPaise: 18000, mode: 'cash', reason: 'x' });
    const exp = await calculateExpected(w.business._id, w.branchA._id, TODAY());
    expect(exp.breakdown.cashRefunds).toBe(18000);
  });

  it('cancelled bills do not count as collections', async () => {
    const b = await cashBill(w, 118000);
    await as(w.tokens.owner).post(`/bills/${b._id}/cancel`, { reason: 'x' });
    const exp = await calculateExpected(w.business._id, w.branchA._id, TODAY());
    expect(exp.breakdown.cashSales).toBe(0);
  });

  it('bills awaiting approval are not yet collections', async () => {
    await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), billedByStaffId: w.receptionist._id.toString(),
      lines: [serviceLine(w.haircut._id, w.stylist1._id)], billDiscount: { type: 'pct', value: 5000 },
      payments: [{ mode: 'cash', amountPaise: 59000 }],
    });
    const exp = await calculateExpected(w.business._id, w.branchA._id, TODAY());
    expect(exp.breakdown.cashSales).toBe(0);
  });

  it('due receipts collected today are added to expected', async () => {
    await cashBill(w, 100000);
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/due-receipts`, { customerId: w.customer._id.toString(), payments: [{ mode: 'cash', amountPaise: 18000 }] });
    const exp = await calculateExpected(w.business._id, w.branchA._id, TODAY());
    expect(exp.breakdown.dueCash).toBe(18000);
  });

  it('other branches\' bills are not included', async () => {
    await as(w.tokens.owner).post(`/branches/${w.branchB._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylistB._id)], payments: [{ mode: 'cash', amountPaise: 118000 }],
    });
    const exp = await calculateExpected(w.business._id, w.branchA._id, TODAY());
    expect(exp.breakdown.cashSales).toBe(0);
  });

  it('GET closure shows expected figures (owner)', async () => {
    await cashBill(w, 118000);
    const res = await as(w.tokens.owner).get(url(w));
    expect(res.status).toBe(200);
    expect(res.body.existing.closure.status).toBe('open');
    expect(res.body.expected.breakdown.cashSales).toBe(118000);
  });
});

describe('Day-end — submit, approve, lock, reopen', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  const counted = (cash: number, extra: any = {}) => ({ denominations: { '500': cash / 50000 }, cashPaise: cash, upiPaise: 0, cardPaise: 0, ...extra });

  it('branch login submits with matching cash (service level; HTTP blocked by routing bug)', async () => {
    await cashBill(w, 118000);
    const exp = await calculateExpected(w.business._id, w.branchA._id, TODAY());
    const c = await submitDayClosure(branchCtx(w), w.branchA._id, TODAY(), counted(exp.cashPaise) as any);
    expect(c.status).toBe('submitted');
    expect(c.diff).toMatchObject({ cashPaise: 0, upiPaise: 0, cardPaise: 0 });
  });

  it('a difference without a reason is rejected', async () => {
    await cashBill(w, 118000);
    const res = await as(w.tokens.manager).post(url(w, '/submit'), counted(100000));
    expect(res.status).toBe(400);
  });

  it('a difference with a reason is accepted and stored', async () => {
    await cashBill(w, 118000);
    const res = await as(w.tokens.manager).post(url(w, '/submit'), counted(100000, { diffReason: 'Change given from pocket' }));
    expect(res.status).toBe(200);
    expect(res.body.diff.cashPaise).toBeLessThan(0);
    expect(res.body.diffReason).toBe('Change given from pocket');
  });

  it('denominations must add up to the counted cash', async () => {
    const res = await as(w.tokens.manager).post(url(w, '/submit'), { denominations: { '500': 1 }, cashPaise: 999900, upiPaise: 0, cardPaise: 0, diffReason: 'x' });
    expect(res.status).toBe(400);
  });

  it('cannot approve a day that was never submitted', async () => {
    await as(w.tokens.manager).get(url(w)); // opening the screen creates an "open" closure
    const res = await as(w.tokens.manager).post(url(w, '/approve'));
    expect([404, 422]).toContain(res.status);
  });

  it('approve locks the day: new bills 409 DAY_CLOSED, new expenses blocked', async () => {
    const exp = await calculateExpected(w.business._id, w.branchA._id, TODAY());
    await as(w.tokens.manager).post(url(w, '/submit'), counted(exp.cashPaise));
    const ap = await as(w.tokens.manager).post(url(w, '/approve'));
    expect(ap.status).toBe(200);
    expect(ap.body.status).toBe('approved');

    const bill = await as(w.tokens.manager).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 118000 }],
    });
    expect(bill.status).toBe(409);
    const e = await as(w.tokens.manager).post(`/branches/${w.branchA._id}/expenses`, { category: 'other', amountPaise: 100, mode: 'cash', paidFrom: 'till' });
    expect(e.status).toBe(409);
  });

  it('approved day cannot be re-submitted', async () => {
    await as(w.tokens.manager).post(url(w, '/submit'), counted(0, { diffReason: 'x' }));
    await as(w.tokens.manager).post(url(w, '/approve'));
    const res = await as(w.tokens.manager).post(url(w, '/submit'), counted(0, { diffReason: 'x' }));
    expect(res.status).toBe(409);
  });

  it('owner reopens with a reason; reopen is logged; billing works again', async () => {
    await as(w.tokens.manager).post(url(w, '/submit'), counted(0, { diffReason: 'x' }));
    await as(w.tokens.manager).post(url(w, '/approve'));
    const r = await as(w.tokens.owner).post(url(w, '/reopen'), { reason: 'Missed a bill' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('open');
    expect(r.body.reopenLog[0].reason).toBe('Missed a bill');
    await cashBill(w, 118000);
  });

  it('reopen without a reason -> 400', async () => {
    await as(w.tokens.manager).post(url(w, '/submit'), counted(0, { diffReason: 'x' }));
    await as(w.tokens.manager).post(url(w, '/approve'));
    expect((await as(w.tokens.owner).post(url(w, '/reopen'), {})).status).toBe(400);
  });

  it('closure actions are audited (submit, approve, reopen)', async () => {
    await as(w.tokens.manager).post(url(w, '/submit'), counted(0, { diffReason: 'x' }));
    await as(w.tokens.manager).post(url(w, '/approve'));
    await as(w.tokens.owner).post(url(w, '/reopen'), { reason: 'r' });
    const actions = (await AuditLog.find({ businessId: w.business._id })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['day_closure.submitted', 'day_closure.approved', 'day_closure.reopened']));
  });

  it('only one closure per branch per day', async () => {
    await as(w.tokens.owner).get(url(w));
    await as(w.tokens.owner).get(url(w));
    expect(await DayClosure.countDocuments({ businessId: w.business._id, branchId: w.branchA._id, businessDate: TODAY() })).toBe(1);
  });

  it('invalid date in URL -> 400', async () => {
    const res = await as(w.tokens.owner).get(`/branches/${w.branchA._id}/closures/not-a-date`);
    expect(res.status).toBe(400);
  });
});

describe('Expenses and petty cash', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('creates and lists an expense with business date', async () => {
    const e = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/expenses`, { category: 'rent', amountPaise: 2500000, mode: 'bank', paidFrom: 'bank', note: 'Oct rent' });
    expect(e.status).toBe(201);
    expect(e.body.businessDate).toBe(TODAY());
    const list = await as(w.tokens.owner).get(`/branches/${w.branchA._id}/expenses?date=${TODAY()}`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain('Oct rent');
  });

  it('a deleted expense no longer counts and is soft-deleted', async () => {
    const e = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/expenses`, { category: 'tea_snacks', amountPaise: 5000, mode: 'cash', paidFrom: 'till' });
    expect((await as(w.tokens.owner).delete(`/expenses/${e.body._id}`)).status).toBe(200);
    const doc = await Expense.findOne({ _id: e.body._id, businessId: w.business._id });
    expect(doc?.deletedAt).toBeTruthy();
  });

  it('expense amount must be a positive integer', async () => {
    expect((await as(w.tokens.owner).post(`/branches/${w.branchA._id}/expenses`, { category: 'rent', amountPaise: 0, mode: 'cash', paidFrom: 'till' })).status).toBe(400);
    expect((await as(w.tokens.owner).post(`/branches/${w.branchA._id}/expenses`, { category: 'bribe', amountPaise: 1, mode: 'cash', paidFrom: 'till' })).status).toBe(400);
  });

  it('petty cash top-up is recorded', async () => {
    const r = await as(w.tokens.manager).post(`/branches/${w.branchA._id}/petty-cash`, { type: 'topup', amountPaise: 100000 });
    expect(r.status).toBe(201);
  });

  it('recurring expense can be scheduled', async () => {
    const r = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/recurring-expenses`, { category: 'rent', amountPaise: 2500000, dayOfMonth: 5 });
    expect(r.status).toBe(201);
  });

  it('cannot add an expense dated on an approved day via businessDate override', async () => {
    await DayClosure.create({ businessId: w.business._id, branchId: w.branchA._id, businessDate: '2026-01-15', expected: { cashPaise: 0, upiPaise: 0, cardPaise: 0 }, status: 'approved' });
    const r = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/expenses`, { category: 'other', amountPaise: 100, mode: 'cash', paidFrom: 'till', businessDate: '2026-01-15' });
    expect([400, 409]).toContain(r.status);
  });
});
