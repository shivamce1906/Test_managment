import '../helpers/testEnv';
import { Types } from 'mongoose';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, World, serviceLine, createPlan, createCustomer, dayOffset } from '../helpers/factory';
import { Customer, CustomerPlan, WalletLedger, LoyaltyLedger, Bill, Business } from '../../src/models';

const cust = (w: World, id: any = w.customer._id) => Customer.findOne({ _id: id, businessId: w.business._id });

/** A customer plan inserted directly (as if sold earlier) so redemption can be tested on its own. */
async function givePackage(w: World, overrides: any = {}) {
  return CustomerPlan.create({
    businessId: w.business._id,
    customerId: w.customer._id,
    planId: new Types.ObjectId(),
    planSnap: { type: 'package', name: '6 Haircuts', pricePaise: 480000 },
    soldBillId: new Types.ObjectId(),
    soldBranchId: w.branchA._id,
    validFrom: dayOffset(-10),
    validTill: dayOffset(170),
    sessions: [{ serviceId: w.haircut._id, total: 6, used: 0, perSessionValuePaise: 80000 }],
    status: 'active',
    log: [{ action: 'redeem', at: new Date(), by: w.owner._id }],
    ...overrides,
  });
}
async function giveMembership(w: World, overrides: any = {}) {
  return CustomerPlan.create({
    businessId: w.business._id,
    customerId: w.customer._id,
    planId: new Types.ObjectId(),
    planSnap: { type: 'membership', name: 'Gold', membership: { serviceDiscountBps: 2000, productDiscountBps: 0 }, branchScope: [] },
    soldBillId: new Types.ObjectId(),
    soldBranchId: w.branchA._id,
    validFrom: dayOffset(-10),
    validTill: dayOffset(355),
    status: 'active',
    log: [{ action: 'redeem', at: new Date(), by: w.owner._id }],
    ...overrides,
  });
}

const billIn = (w: World, body: any) => as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, { customerId: w.customer._id.toString(), ...body });

describe('Selling prepaid instruments on a bill (PRD §8)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('owner can create a membership plan', async () => {
    const res = await as(w.tokens.owner).post('/plans', {
      type: 'membership', name: 'Gold', pricePaise: 200000, validityDays: 365, membership: { serviceDiscountBps: 2000 },
    });
    expect(res.status).toBe(201);
  });

  it('selling a membership creates an active customer plan valid for N days', async () => {
    const plan = await createPlan(w.business._id, { type: 'membership', name: 'Gold', pricePaise: 200000, validityDays: 365, membership: { serviceDiscountBps: 2000 } });
    const res = await billIn(w, { lines: [{ kind: 'membership', refId: plan._id.toString() }], payments: [{ mode: 'cash', amountPaise: 236000 }] });
    expect(res.status).toBe(201);
    const cp = await CustomerPlan.findOne({ businessId: w.business._id, customerId: w.customer._id });
    expect(cp?.status).toBe('active');
    expect(cp?.validTill).toBe(dayOffset(365));
  });

  it('selling a package creates sessions with per-session value', async () => {
    const plan = await createPlan(w.business._id, { type: 'package', name: '6 Haircuts', pricePaise: 480000, validityDays: 180, package: { items: [{ serviceId: w.haircut._id, sessions: 6 }] } });
    const res = await billIn(w, { lines: [{ kind: 'package', refId: plan._id.toString() }], payments: [{ mode: 'cash', amountPaise: 566400 }] });
    expect(res.status).toBe(201);
    const cp = await CustomerPlan.findOne({ businessId: w.business._id, customerId: w.customer._id });
    expect(cp?.sessions?.[0]).toMatchObject({ total: 6, used: 0, perSessionValuePaise: 80000 });
  });

  it('wallet offer: pay ₹10,000 get ₹12,000 credit (topup + bonus ledger rows)', async () => {
    const plan = await createPlan(w.business._id, { type: 'wallet_offer', name: 'Pay 10k get 12k', pricePaise: 1000000, validityDays: 365, walletOffer: { creditPaise: 1200000 } });
    const res = await billIn(w, { lines: [{ kind: 'wallet_topup', refId: plan._id.toString() }], payments: [{ mode: 'cash', amountPaise: 1000000 }] });
    expect(res.status).toBe(201);
    expect((await cust(w))!.walletBalancePaise).toBe(1200000);
    const rows = await WalletLedger.find({ businessId: w.business._id }).sort({ createdAt: 1 });
    expect(rows.map((r) => [r.type, r.amountPaise])).toEqual([['topup', 1000000], ['bonus', 200000]]);
  });

  it('gift voucher sale issues a unique voucher code that can be looked up', async () => {
    const plan = await createPlan(w.business._id, { type: 'voucher', name: '₹2,000 voucher', pricePaise: 200000, validityDays: 90, voucher: { valuePaise: 200000 } });
    const res = await billIn(w, { lines: [{ kind: 'voucher', refId: plan._id.toString() }], payments: [{ mode: 'cash', amountPaise: 200000 }] });
    expect(res.status).toBe(201);
    const cp = await CustomerPlan.findOne({ businessId: w.business._id, customerId: w.customer._id });
    expect(cp?.voucherCode).toBeTruthy();
    const look = await as(w.tokens.branchA).get(`/vouchers/${cp!.voucherCode}`);
    expect(look.status).toBe(200);
  });

  it('cancelling a bill that sold an unused package cancels the package', async () => {
    const plan = await createPlan(w.business._id, { type: 'package', name: '6 Haircuts', pricePaise: 480000, validityDays: 180, package: { items: [{ serviceId: w.haircut._id, sessions: 6 }] } });
    const b = await billIn(w, { lines: [{ kind: 'package', refId: plan._id.toString() }], payments: [{ mode: 'cash', amountPaise: 566400 }] });
    await as(w.tokens.owner).post(`/bills/${b.body._id}/cancel`, { reason: 'x' });
    const cp = await CustomerPlan.findOne({ businessId: w.business._id, soldBillId: b.body._id });
    expect(cp?.status).toBe('cancelled');
  });

  it('cancelling a bill that sold a wallet top-up removes the credit (or is blocked if spent)', async () => {
    const plan = await createPlan(w.business._id, { type: 'wallet_offer', name: 'W', pricePaise: 1000000, validityDays: 365, walletOffer: { creditPaise: 1200000 } });
    const b = await billIn(w, { lines: [{ kind: 'wallet_topup', refId: plan._id.toString() }], payments: [{ mode: 'cash', amountPaise: 1000000 }] });
    const c = await as(w.tokens.owner).post(`/bills/${b.body._id}/cancel`, { reason: 'x' });
    if (c.status === 200) expect((await cust(w))!.walletBalancePaise).toBe(0);
    else expect(c.status).toBe(422);
  });
});

describe('Redeeming prepaid instruments', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('package redemption zeroes the line and consumes one session', async () => {
    const cp = await givePackage(w);
    const res = await billIn(w, {
      lines: [serviceLine(w.haircut._id, w.stylist1._id)],
      redemptions: [{ kind: 'package', refId: cp._id.toString(), lineId: '0' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.totals.totalPaise).toBe(0);
    const after = await CustomerPlan.findOne({ _id: cp._id, businessId: w.business._id });
    expect(after!.sessions![0].used).toBe(1);
  });

  it('commission on a package session is paid on the per-session value (₹800 @10% = ₹80)', async () => {
    const cp = await givePackage(w);
    const res = await billIn(w, {
      lines: [serviceLine(w.haircut._id, w.stylist1._id)],
      redemptions: [{ kind: 'package', refId: cp._id.toString(), lineId: '0' }],
    });
    expect(res.body.lines?.[0]?.staff?.[0]?.commissionPaise).toBe(8000);
  });

  it('no sessions left -> 422 NO_SESSIONS_LEFT', async () => {
    const cp = await givePackage(w, { sessions: [{ serviceId: w.haircut._id, total: 6, used: 6, perSessionValuePaise: 80000 }] });
    const res = await billIn(w, {
      lines: [serviceLine(w.haircut._id, w.stylist1._id)],
      redemptions: [{ kind: 'package', refId: cp._id.toString(), lineId: '0' }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NO_SESSIONS_LEFT');
  });

  it('package for a different service cannot be redeemed', async () => {
    const cp = await givePackage(w);
    const res = await billIn(w, {
      lines: [serviceLine(w.colour._id, w.stylist1._id)],
      redemptions: [{ kind: 'package', refId: cp._id.toString(), lineId: '0' }],
    });
    expect(res.status).toBe(422);
  });

  it('another customer\'s package cannot be redeemed', async () => {
    const other = await createCustomer(w.business._id, { name: 'Other' });
    const cp = await givePackage(w, { customerId: other._id });
    const res = await billIn(w, {
      lines: [serviceLine(w.haircut._id, w.stylist1._id)],
      redemptions: [{ kind: 'package', refId: cp._id.toString(), lineId: '0' }],
    });
    expect(res.status).toBe(422);
  });

  it('EDGE: expired package (validTill in the past) cannot be redeemed', async () => {
    const cp = await givePackage(w, { validTill: dayOffset(-1) });
    const res = await billIn(w, {
      lines: [serviceLine(w.haircut._id, w.stylist1._id)],
      redemptions: [{ kind: 'package', refId: cp._id.toString(), lineId: '0' }],
    });
    expect(res.status).toBe(422);
  });

  it('EDGE: package restricted to branch B cannot be used in branch A (PLAN_OUT_OF_SCOPE)', async () => {
    const cp = await givePackage(w, { planSnap: { type: 'package', branchScope: [w.branchB._id] } });
    const res = await billIn(w, {
      lines: [serviceLine(w.haircut._id, w.stylist1._id)],
      redemptions: [{ kind: 'package', refId: cp._id.toString(), lineId: '0' }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PLAN_OUT_OF_SCOPE');
  });

  it('frozen membership gives no discount', async () => {
    const cp = await giveMembership(w, { status: 'frozen' });
    const res = await billIn(w, {
      lines: [serviceLine(w.haircut._id, w.stylist1._id)],
      redemptions: [{ kind: 'membership', refId: cp._id.toString() }],
      payments: [{ mode: 'cash', amountPaise: 118000 }],
    });
    expect(res.status).toBe(422);
  });

  it('active membership gives 20% off services', async () => {
    const cp = await giveMembership(w);
    const res = await billIn(w, {
      lines: [serviceLine(w.haircut._id, w.stylist1._id)],
      redemptions: [{ kind: 'membership', refId: cp._id.toString() }],
      payments: [{ mode: 'cash', amountPaise: 94400 }],
    });
    expect(res.body.totals.taxablePaise).toBe(80000);
  });

  it('EDGE: expired membership gives no discount', async () => {
    const cp = await giveMembership(w, { validTill: dayOffset(-1) });
    const res = await billIn(w, {
      lines: [serviceLine(w.haircut._id, w.stylist1._id)],
      redemptions: [{ kind: 'membership', refId: cp._id.toString() }],
      payments: [{ mode: 'cash', amountPaise: 118000 }],
    });
    expect(res.status === 422 || res.body.totals?.taxablePaise === 100000).toBe(true);
  });

  it('SECURITY: loyalty redemption value is computed by the server, not trusted from the client', async () => {
    await Customer.updateOne({ _id: w.customer._id, businessId: w.business._id }, { $set: { loyaltyPoints: 100 } });
    // 100 points × ₹1 = ₹100 off. Client claims ₹1,000.
    const res = await billIn(w, {
      lines: [serviceLine(w.haircut._id, w.stylist1._id)],
      redemptions: [{ kind: 'loyalty', refId: w.customer._id.toString(), points: 100, amountPaise: 100000 }],
      payments: [{ mode: 'cash', amountPaise: 106200 }],
    });
    expect(res.body.totals?.taxablePaise).toBe(90000);
  });

  it('loyalty redemption below the minimum is rejected', async () => {
    await Customer.updateOne({ _id: w.customer._id, businessId: w.business._id }, { $set: { loyaltyPoints: 100 } });
    // minRedeem in seed = 10
    const res = await billIn(w, {
      lines: [serviceLine(w.haircut._id, w.stylist1._id)],
      redemptions: [{ kind: 'loyalty', refId: w.customer._id.toString(), points: 5, amountPaise: 500 }],
    });
    expect(res.status).toBe(422);
  });

  it('loyalty redemption when the business has loyalty switched off is rejected', async () => {
    await Business.updateOne({ _id: w.business._id }, { $set: { 'loyalty.enabled': false } });
    await Customer.updateOne({ _id: w.customer._id, businessId: w.business._id }, { $set: { loyaltyPoints: 100 } });
    const res = await billIn(w, {
      lines: [serviceLine(w.haircut._id, w.stylist1._id)],
      redemptions: [{ kind: 'loyalty', refId: w.customer._id.toString(), points: 50, amountPaise: 5000 }],
    });
    expect(res.status).toBe(422);
  });

  it('loyalty redeem posts a ledger row and reduces points', async () => {
    await Customer.updateOne({ _id: w.customer._id, businessId: w.business._id }, { $set: { loyaltyPoints: 100 } });
    await billIn(w, {
      lines: [serviceLine(w.haircut._id, w.stylist1._id)],
      redemptions: [{ kind: 'loyalty', refId: w.customer._id.toString(), points: 50, amountPaise: 5000 }],
      payments: [{ mode: 'cash', amountPaise: 112100 }],
    });
    expect((await LoyaltyLedger.findOne({ businessId: w.business._id, type: 'redeem' }))?.points).toBe(-50);
  });

  it('gift voucher redemption reduces the bill and marks the voucher used (redeemable once)', async () => {
    const v = await CustomerPlan.create({
      businessId: w.business._id, customerId: w.customer._id, planId: new Types.ObjectId(),
      planSnap: { type: 'voucher', voucher: { valuePaise: 50000 } }, soldBillId: new Types.ObjectId(), soldBranchId: w.branchA._id,
      validFrom: dayOffset(-1), validTill: dayOffset(30), voucherCode: 'GIFT-ABC', status: 'active',
      log: [{ action: 'redeem', at: new Date(), by: w.owner._id }],
    });
    const r1 = await billIn(w, {
      lines: [serviceLine(w.haircut._id, w.stylist1._id)],
      redemptions: [{ kind: 'voucher', refId: v._id.toString(), amountPaise: 50000 }],
      payments: [{ mode: 'cash', amountPaise: 59000 }],
    });
    expect(r1.body.totals.taxablePaise).toBe(50000);
    const r2 = await billIn(w, {
      lines: [serviceLine(w.haircut._id, w.stylist1._id)],
      redemptions: [{ kind: 'voucher', refId: v._id.toString(), amountPaise: 50000 }],
      payments: [{ mode: 'cash', amountPaise: 59000 }],
    });
    expect(r2.status).toBe(422);
  });

  it('cancelling a bill restores the redeemed package session', async () => {
    const cp = await givePackage(w);
    const b = await billIn(w, {
      lines: [serviceLine(w.haircut._id, w.stylist1._id)],
      redemptions: [{ kind: 'package', refId: cp._id.toString(), lineId: '0' }],
    });
    expect(b.status).toBe(201);
    await as(w.tokens.owner).post(`/bills/${b.body._id}/cancel`, { reason: 'x' });
    expect((await CustomerPlan.findOne({ _id: cp._id, businessId: w.business._id }))!.sessions![0].used).toBe(0);
  });

  it('cancelling a bill restores redeemed loyalty points', async () => {
    await Customer.updateOne({ _id: w.customer._id, businessId: w.business._id }, { $set: { loyaltyPoints: 100 } });
    const b = await billIn(w, {
      lines: [serviceLine(w.haircut._id, w.stylist1._id)],
      redemptions: [{ kind: 'loyalty', refId: w.customer._id.toString(), points: 50, amountPaise: 5000 }],
      payments: [{ mode: 'cash', amountPaise: 112100 }],
    });
    await as(w.tokens.owner).post(`/bills/${b.body._id}/cancel`, { reason: 'x' });
    expect((await cust(w))!.loyaltyPoints).toBe(100);
  });
});

describe('Customer plan management and wallet adjustments', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('extend adds days and logs the action', async () => {
    const cp = await givePackage(w);
    const res = await as(w.tokens.manager).post(`/customer-plans/${cp._id}/extend`, { days: 30 });
    expect(res.status).toBe(200);
    expect(res.body.validTill).toBe(dayOffset(200));
    expect(res.body.log.some((l: any) => l.action === 'extend')).toBe(true);
  });

  it('freeze then unfreeze extends validity by the frozen days (min 1)', async () => {
    const cp = await giveMembership(w);
    expect((await as(w.tokens.manager).post(`/customer-plans/${cp._id}/freeze`, { reason: 'Travel' })).body.status).toBe('frozen');
    const res = await as(w.tokens.manager).post(`/customer-plans/${cp._id}/unfreeze`);
    expect(res.body.status).toBe('active');
    expect(res.body.validTill > cp.validTill).toBe(true);
  });

  it('owner can transfer an active package to another customer of the same business', async () => {
    const cp = await givePackage(w);
    const to = await createCustomer(w.business._id, { name: 'Sister' });
    const res = await as(w.tokens.owner).post(`/customer-plans/${cp._id}/transfer`, { toCustomerId: to._id.toString() });
    expect(res.status).toBe(200);
    expect(res.body.customerId).toBe(to._id.toString());
  });

  it('cannot transfer a plan to a customer of another business', async () => {
    const cp = await givePackage(w);
    const res = await as(w.tokens.owner).post(`/customer-plans/${cp._id}/transfer`, { toCustomerId: w.otherCustomer._id.toString() });
    expect(res.status).toBe(404);
  });

  it('invalid state transitions are 422 INVALID_TRANSITION (SRS error table)', async () => {
    const cp = await givePackage(w, { status: 'cancelled' });
    const res = await as(w.tokens.manager).post(`/customer-plans/${cp._id}/freeze`, { reason: 'x' });
    expect(res.status).toBe(422);
  });

  it('sold plans: only `active` can be edited (price is immutable)', async () => {
    const plan = await createPlan(w.business._id, { type: 'membership', name: 'Gold', pricePaise: 200000 });
    const res = await as(w.tokens.owner).patch(`/plans/${plan._id}`, { pricePaise: 1 });
    expect(res.status === 400 || res.body.pricePaise === 200000).toBe(true);
  });

  it('owner wallet adjustment posts a signed ledger row with reason', async () => {
    const res = await as(w.tokens.owner).post(`/customers/${w.customer._id}/wallet/adjust`, { amountPaise: 5000, reason: 'Goodwill' });
    expect(res.status).toBe(200);
    expect((await cust(w))!.walletBalancePaise).toBe(5000);
    const row = await WalletLedger.findOne({ businessId: w.business._id, type: 'adjust' });
    expect(row).toMatchObject({ amountPaise: 5000, reason: 'Goodwill', balanceAfterPaise: 5000 });
  });

  it('wallet cannot be adjusted below zero', async () => {
    const res = await as(w.tokens.owner).post(`/customers/${w.customer._id}/wallet/adjust`, { amountPaise: -1, reason: 'x' });
    expect(res.status).toBe(422);
  });

  it('wallet balance equals the sum of its ledger (Database Design: balance is a cache)', async () => {
    await as(w.tokens.owner).post(`/customers/${w.customer._id}/wallet/adjust`, { amountPaise: 20000, reason: 'a' });
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylist1._id)],
      payments: [{ mode: 'wallet', amountPaise: 20000 }, { mode: 'cash', amountPaise: 98000 }],
    });
    const rows = await WalletLedger.find({ businessId: w.business._id, customerId: w.customer._id });
    const sum = rows.reduce((a, r) => a + r.amountPaise, 0);
    expect((await cust(w))!.walletBalancePaise).toBe(sum);
  });

  it('wallet ledger is readable by the branch', async () => {
    const res = await as(w.tokens.branchA).get(`/customers/${w.customer._id}/wallet/ledger`);
    expect(res.status).toBe(200);
  });

  it('unknown voucher code -> 404', async () => {
    expect((await as(w.tokens.branchA).get('/vouchers/NOPE')).status).toBe(404);
  });

  it('bills total integrity: no bills created by failed prepaid operations', async () => {
    const before = await Bill.countDocuments({ businessId: w.business._id });
    await billIn(w, { lines: [{ kind: 'membership', refId: new Types.ObjectId().toString() }] });
    expect(await Bill.countDocuments({ businessId: w.business._id })).toBe(before);
  });
});
