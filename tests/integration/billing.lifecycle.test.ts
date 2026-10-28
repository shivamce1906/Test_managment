import '../helpers/testEnv';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, World, serviceLine } from '../helpers/factory';
import {
  Bill, BillVersion, StockBalance, Customer, Due, DayClosure, DailySummary, AuditLog, WalletLedger,
} from '../../src/models';
import { getBusinessDate } from '../../src/utils';

const stock = async (w: World, productId: any, pool: string) =>
  (await StockBalance.findOne({ businessId: w.business._id, branchId: w.branchA._id, productId, pool }))?.qty;
const cust = (w: World) => Customer.findOne({ _id: w.customer._id, businessId: w.business._id });

async function productBill(w: World, token: string, extra: any = {}) {
  const r = await as(token).post(`/branches/${w.branchA._id}/bills`, {
    customerId: w.customer._id.toString(),
    billedByStaffId: w.receptionist._id.toString(),
    lines: [{ kind: 'product', refId: w.retail._id.toString(), qty: 2 }, serviceLine(w.colour._id, w.stylist1._id)],
    payments: [{ mode: 'cash', amountPaise: 413000 }],
    ...extra,
  });
  return r;
}

describe('Bill cancel (PRD §7: never deletes, reverses everything)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('cancel marks the bill Cancelled, keeps it, and restores retail + consumable stock', async () => {
    const b = await productBill(w, w.tokens.branchA);
    expect(b.body.status).toBe('paid');
    expect(await stock(w, w.retail._id, 'retail')).toBe(8);
    expect(await stock(w, w.consumable._id, 'consumable')).toBe(470);

    const c = await as(w.tokens.manager).post(`/bills/${b.body._id}/cancel`, { reason: 'Wrong customer' });
    expect(c.status).toBe(200);
    expect(c.body.status).toBe('cancelled');
    expect(c.body.cancel.reason).toBe('Wrong customer');
    expect(await Bill.countDocuments({ businessId: w.business._id })).toBe(1);
    expect(await stock(w, w.retail._id, 'retail')).toBe(10);
    expect(await stock(w, w.consumable._id, 'consumable')).toBe(500);
  });

  it('reason is mandatory', async () => {
    const b = await productBill(w, w.tokens.branchA);
    expect((await as(w.tokens.manager).post(`/bills/${b.body._id}/cancel`, {})).status).toBe(400);
  });

  it('cancelling twice -> 422', async () => {
    const b = await productBill(w, w.tokens.branchA);
    await as(w.tokens.manager).post(`/bills/${b.body._id}/cancel`, { reason: 'x' });
    expect((await as(w.tokens.manager).post(`/bills/${b.body._id}/cancel`, { reason: 'x' })).status).toBe(422);
  });

  it('cancel refunds a wallet payment back to the wallet', async () => {
    await Customer.updateOne({ _id: w.customer._id, businessId: w.business._id }, { $set: { walletBalancePaise: 413000 } });
    const b = await productBill(w, w.tokens.branchA, { payments: [{ mode: 'wallet', amountPaise: 413000 }] });
    expect((await cust(w))!.walletBalancePaise).toBe(0);
    await as(w.tokens.manager).post(`/bills/${b.body._id}/cancel`, { reason: 'x' });
    expect((await cust(w))!.walletBalancePaise).toBe(413000);
    expect(await WalletLedger.countDocuments({ businessId: w.business._id, type: 'reverse' })).toBe(1);
  });

  it('cancel voids the due and clears it from the customer', async () => {
    const b = await productBill(w, w.tokens.owner, { payments: [{ mode: 'cash', amountPaise: 400000 }] });
    expect((await cust(w))!.duePaise).toBe(13000);
    await as(w.tokens.owner).post(`/bills/${b.body._id}/cancel`, { reason: 'x' });
    expect((await Due.findOne({ businessId: w.business._id, billId: b.body._id }))!.status).toBe('void');
    expect((await cust(w))!.duePaise).toBe(0);
  });

  it('cancel reverses customer visit stats', async () => {
    const b = await productBill(w, w.tokens.branchA);
    await as(w.tokens.manager).post(`/bills/${b.body._id}/cancel`, { reason: 'x' });
    const c = await cust(w);
    expect(c!.stats.visits).toBe(0);
    expect(c!.stats.spendPaise).toBe(0);
  });

  it('cancel removes the bill\'s collections from the daily summary', async () => {
    const b = await productBill(w, w.tokens.branchA);
    await as(w.tokens.manager).post(`/bills/${b.body._id}/cancel`, { reason: 'x' });
    const s: any = await DailySummary.findById(`${w.branchA._id}:${getBusinessDate()}`).lean();
    expect(s.counts.cancelled).toBe(1);
    expect(s.sales.netPaise).toBe(0);
    expect(s.collections?.cash || 0).toBe(0);
  });

  it('writes bill.cancel to the audit log with the reason', async () => {
    const b = await productBill(w, w.tokens.branchA);
    await as(w.tokens.manager).post(`/bills/${b.body._id}/cancel`, { reason: 'Duplicate' });
    const log = await AuditLog.findOne({ businessId: w.business._id, action: 'bill.cancel' });
    expect(log?.reason).toBe('Duplicate');
  });

  it('EDGE: cancelling a bill still awaiting approval must not add stock that was never deducted', async () => {
    const b = await productBill(w, w.tokens.branchA, { billDiscount: { type: 'pct', value: 5000 }, payments: [{ mode: 'cash', amountPaise: 206500 }] });
    expect(b.body.status).toBe('awaiting_approval');
    expect(await stock(w, w.retail._id, 'retail')).toBe(10);
    await as(w.tokens.manager).post(`/bills/${b.body._id}/cancel`, { reason: 'x' });
    expect(await stock(w, w.retail._id, 'retail')).toBe(10);
    expect(await stock(w, w.consumable._id, 'consumable')).toBe(500);
  });

  it('EDGE: cancelling a rejected bill is not allowed (nothing to reverse)', async () => {
    const b = await productBill(w, w.tokens.branchA, { billDiscount: { type: 'pct', value: 5000 }, payments: [{ mode: 'cash', amountPaise: 206500 }] });
    await as(w.tokens.manager).post(`/bills/${b.body._id}/decide`, { decision: 'reject', reason: 'no' });
    const res = await as(w.tokens.manager).post(`/bills/${b.body._id}/cancel`, { reason: 'x' });
    expect(res.status).toBe(422);
  });

  it('on an approved (closed) day only the owner can cancel', async () => {
    const b = await productBill(w, w.tokens.branchA);
    await DayClosure.create({
      businessId: w.business._id, branchId: w.branchA._id, businessDate: getBusinessDate(),
      expected: { cashPaise: 0, upiPaise: 0, cardPaise: 0 }, status: 'approved',
    });
    const m = await as(w.tokens.manager).post(`/bills/${b.body._id}/cancel`, { reason: 'x' });
    expect(m.status).toBe(409);
    expect(m.body.error.code).toBe('DAY_CLOSED');
    expect((await as(w.tokens.owner).post(`/bills/${b.body._id}/cancel`, { reason: 'x' })).status).toBe(200);
  });
});

describe('Bill refund', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  const paid = async (w: World) =>
    (await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), billedByStaffId: w.receptionist._id.toString(),
      lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 118000 }],
    })).body;

  it('partial refund -> partly_refunded; remainder -> refunded', async () => {
    const b = await paid(w);
    const r1 = await as(w.tokens.manager).post(`/bills/${b._id}/refund`, { amountPaise: 18000, mode: 'cash', reason: 'Unhappy' });
    expect(r1.body.status).toBe('partly_refunded');
    const r2 = await as(w.tokens.manager).post(`/bills/${b._id}/refund`, { amountPaise: 100000, mode: 'upi', reason: 'Unhappy' });
    expect(r2.body.status).toBe('refunded');
    expect(r2.body.refunds).toHaveLength(2);
  });

  it('cannot refund more than was paid', async () => {
    const b = await paid(w);
    const r = await as(w.tokens.manager).post(`/bills/${b._id}/refund`, { amountPaise: 118001, mode: 'cash', reason: 'x' });
    expect(r.status).toBe(422);
  });

  it('refund needs a reason and a positive amount', async () => {
    const b = await paid(w);
    expect((await as(w.tokens.manager).post(`/bills/${b._id}/refund`, { amountPaise: 100, mode: 'cash' })).status).toBe(400);
    expect((await as(w.tokens.manager).post(`/bills/${b._id}/refund`, { amountPaise: 0, mode: 'cash', reason: 'x' })).status).toBe(400);
  });

  it('cannot refund a cancelled bill', async () => {
    const b = await paid(w);
    await as(w.tokens.manager).post(`/bills/${b._id}/cancel`, { reason: 'x' });
    expect((await as(w.tokens.manager).post(`/bills/${b._id}/refund`, { amountPaise: 100, mode: 'cash', reason: 'x' })).status).toBe(422);
  });

  it('EDGE: cannot refund a bill that is still awaiting approval', async () => {
    const r = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), billedByStaffId: w.receptionist._id.toString(),
      lines: [serviceLine(w.haircut._id, w.stylist1._id)], billDiscount: { type: 'pct', value: 5000 },
      payments: [{ mode: 'cash', amountPaise: 59000 }],
    });
    expect(r.body.status).toBe('awaiting_approval');
    const res = await as(w.tokens.manager).post(`/bills/${r.body._id}/refund`, { amountPaise: 59000, mode: 'cash', reason: 'x' });
    expect(res.status).toBe(422);
  });

  it('refund reduces the day\'s collection in the daily summary', async () => {
    const b = await paid(w);
    await as(w.tokens.manager).post(`/bills/${b._id}/refund`, { amountPaise: 18000, mode: 'cash', reason: 'x' });
    const s: any = await DailySummary.findById(`${w.branchA._id}:${getBusinessDate()}`).lean();
    expect(s.refundsPaise).toBe(18000);
  });

  it('refund is audited', async () => {
    const b = await paid(w);
    await as(w.tokens.manager).post(`/bills/${b._id}/refund`, { amountPaise: 100, mode: 'cash', reason: 'Late' });
    expect(await AuditLog.findOne({ businessId: w.business._id, action: 'bill.refund', reason: 'Late' })).toBeTruthy();
  });
});

describe('Bill edit (PRD §7: new version, reason mandatory)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  const edited = (w: World, b: any, extra: any = {}) => ({
    customerId: w.customer._id.toString(),
    lines: [{ kind: 'product', refId: w.retail._id.toString(), qty: 1 }],
    payments: [{ mode: 'cash', amountPaise: 59000 }],
    reason: 'Customer returned one bottle',
    __v: b.__v,
    ...extra,
  });

  it('edit creates version 2, stores a BillVersion snapshot and keeps the invoice number', async () => {
    const b = (await productBill(w, w.tokens.branchA)).body;
    const res = await as(w.tokens.manager).patch(`/bills/${b._id}`, edited(w, b));
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
    expect(res.body.invoiceNo).toBe(b.invoiceNo);
    const v = await BillVersion.findOne({ businessId: w.business._id, billId: b._id });
    expect(v?.version).toBe(1);
    expect(v?.reason).toBe('Customer returned one bottle');
  });

  it('reason is mandatory for an edit', async () => {
    const b = (await productBill(w, w.tokens.branchA)).body;
    const { reason, payments, ...noReason } = edited(w, b);
    const res = await as(w.tokens.manager).patch(`/bills/${b._id}`, noReason);
    expect(res.status).toBe(400);
  });

  it('edit that only changes lines (payments untouched) succeeds', async () => {
    const b = (await productBill(w, w.tokens.branchA)).body;
    const { payments, ...noPayments } = edited(w, b);
    const res = await as(w.tokens.manager).patch(`/bills/${b._id}`, noPayments);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
  });

  it('a body without lines is a 400, not a 500', async () => {
    const b = (await productBill(w, w.tokens.branchA)).body;
    const res = await as(w.tokens.manager).patch(`/bills/${b._id}`, { reason: 'x', __v: b.__v });
    expect(res.status).toBe(400);
  });

  it('edit reverses the old version\'s stock and applies the new one (2 bottles + colour -> 1 bottle)', async () => {
    const b = (await productBill(w, w.tokens.branchA)).body;
    await as(w.tokens.manager).patch(`/bills/${b._id}`, edited(w, b));
    expect(await stock(w, w.retail._id, 'retail')).toBe(9);
    expect(await stock(w, w.consumable._id, 'consumable')).toBe(500);
  });

  it('stale __v -> 409 VERSION_CONFLICT', async () => {
    const b = (await productBill(w, w.tokens.branchA)).body;
    const res = await as(w.tokens.manager).patch(`/bills/${b._id}`, edited(w, b, { __v: 99 }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VERSION_CONFLICT');
  });

  it('cannot edit a cancelled bill', async () => {
    const b = (await productBill(w, w.tokens.branchA)).body;
    await as(w.tokens.manager).post(`/bills/${b._id}/cancel`, { reason: 'x' });
    const fresh = await Bill.findOne({ _id: b._id, businessId: w.business._id });
    const res = await as(w.tokens.manager).patch(`/bills/${b._id}`, edited(w, b, { __v: fresh!.__v }));
    expect(res.status).toBe(422);
  });

  it('manager cannot edit a bill on a closed day', async () => {
    const b = (await productBill(w, w.tokens.branchA)).body;
    await DayClosure.create({
      businessId: w.business._id, branchId: w.branchA._id, businessDate: getBusinessDate(),
      expected: { cashPaise: 0, upiPaise: 0, cardPaise: 0 }, status: 'approved',
    });
    expect((await as(w.tokens.manager).patch(`/bills/${b._id}`, edited(w, b))).status).toBe(409);
  });

  it('edit is audited with before/after', async () => {
    const b = (await productBill(w, w.tokens.branchA)).body;
    await as(w.tokens.manager).patch(`/bills/${b._id}`, edited(w, b));
    const log: any = await AuditLog.findOne({ businessId: w.business._id, action: 'bill.edit' }).lean();
    expect(log).toBeTruthy();
    expect(log.before).toBeTruthy();
    expect(log.after).toBeTruthy();
  });

  it('GET /bills/:id returns the bill with its versions', async () => {
    const b = (await productBill(w, w.tokens.branchA)).body;
    await as(w.tokens.manager).patch(`/bills/${b._id}`, edited(w, b));
    const res = await as(w.tokens.manager).get(`/bills/${b._id}`);
    expect(res.body.versions).toHaveLength(1);
  });
});
