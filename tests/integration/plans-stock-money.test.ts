import '../helpers/testEnv';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, World, serviceLine, createPlan } from '../helpers/factory';
import { CustomerPlan, Product, Vendor } from '../../src/models';
import { getBusinessDate } from '../../src/utils';

const billIn = (w: World, body: any) =>
  as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, { customerId: w.customer._id.toString(), ...body });

describe('Phase 3: plans', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('a plan must carry the block for its type, and a wallet offer cannot credit less than its price', async () => {
    expect((await as(w.tokens.owner).post('/plans', { type: 'package', name: 'P', pricePaise: 1000, validityDays: 30 })).status).toBe(400);
    const r = await as(w.tokens.owner).post('/plans', { type: 'wallet_offer', name: 'W', pricePaise: 1000, validityDays: 30, walletOffer: { creditPaise: 500 } });
    expect(r.status).toBe(400);
    expect(r.body.error.fields).toHaveProperty(['walletOffer.creditPaise']);
  });

  it('a package cannot include another business\'s service; managers cannot create plans', async () => {
    const foreign = await as(w.tokens.otherOwner).post('/plans', {
      type: 'package', name: 'P', pricePaise: 1000, validityDays: 30, package: { items: [{ serviceId: w.haircut._id.toString(), sessions: 2 }] },
    });
    expect(foreign.status).toBe(404);
    expect((await as(w.tokens.manager).post('/plans', { type: 'membership', name: 'M', pricePaise: 1, validityDays: 1, membership: {} })).status).toBe(403);
  });

  it('a sold voucher gets a GV- code; redeeming it is server-valued and once only', async () => {
    const plan = await createPlan(w.business._id, { type: 'voucher', name: 'V', pricePaise: 50000, validityDays: 30, voucher: { valuePaise: 50000 } });
    await billIn(w, { lines: [{ kind: 'voucher', refId: plan._id.toString() }], payments: [{ mode: 'cash', amountPaise: 50000 }] });
    const v = await CustomerPlan.findOne({ businessId: w.business._id, soldBillId: { $exists: true }, voucherCode: /^GV-/ });
    expect(v?.voucherCode).toMatch(/^GV-[A-Z2-9]{8}$/);
    const use = await billIn(w, {
      lines: [serviceLine(w.haircut._id, w.stylist1._id)],
      redemptions: [{ kind: 'voucher', refId: v!._id.toString(), amountPaise: 999999 }],
      payments: [{ mode: 'cash', amountPaise: 59000 }],
    });
    expect(use.status).toBe(201);
    expect(use.body.totals.taxablePaise).toBe(50000);
    expect((await as(w.tokens.branchA).get(`/vouchers/${v!.voucherCode}`)).status).toBe(422);
  });

  it('wallet and loyalty summaries', async () => {
    await as(w.tokens.owner).post(`/customers/${w.customer._id}/wallet/adjust`, { amountPaise: 5000, reason: 'Goodwill' });
    const wallet = await as(w.tokens.branchA).get(`/customers/${w.customer._id}/wallet`);
    expect(wallet.status).toBe(200);
    expect(wallet.body.balancePaise).toBe(5000);
    expect(wallet.body.ledger).toHaveLength(1);
    await billIn(w, { billedByStaffId: w.receptionist._id.toString(), lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 118000 }] });
    const loyalty = await as(w.tokens.branchA).get(`/customers/${w.customer._id}/loyalty`);
    expect(loyalty.body).toMatchObject({ points: 11, valuePaise: 1100, rules: { enabled: true, minRedeem: 10 } });
  });

  it('customer plans past their validity show as expired', async () => {
    const plan = await createPlan(w.business._id, { type: 'membership', name: 'M', pricePaise: 1000, validityDays: 30, membership: { serviceDiscountBps: 1000 } });
    await billIn(w, { lines: [{ kind: 'membership', refId: plan._id.toString() }], payments: [{ mode: 'cash', amountPaise: 1180 }] });
    await CustomerPlan.updateOne({ businessId: w.business._id, customerId: w.customer._id }, { $set: { validTill: '2020-01-01' } });
    const list = await as(w.tokens.owner).get(`/customers/${w.customer._id}/plans`);
    expect(list.body[0].status).toBe('expired');
  });
});

describe('Phase 3: stock', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('stock rows carry the reorder level, a low flag and value; lowOnly filters', async () => {
    await Product.updateOne({ _id: w.retail._id, businessId: w.business._id }, { $set: { reorderLevels: [{ branchId: w.branchA._id, qty: 12 }] } });
    const all = await as(w.tokens.owner).get(`/branches/${w.branchA._id}/stock`);
    const row = all.body.find((r: any) => r.productId.name === 'Argan Shampoo');
    expect(row).toMatchObject({ qty: 10, reorderLevel: 12, low: true, valuePaise: 300000 });
    const low = await as(w.tokens.owner).get(`/branches/${w.branchA._id}/stock?lowOnly=true`);
    expect(low.body).toHaveLength(1);
  });

  it('PO detail shows vendor and product names; a manager cannot open another branch\'s PO', async () => {
    const v = await Vendor.create({ businessId: w.business._id, name: 'Distributor' });
    const po = await as(w.tokens.owner).post('/purchase-orders', {
      branchId: w.branchB._id.toString(), vendorId: v._id.toString(),
      items: [{ productId: w.retail._id.toString(), qtyPurchaseUnits: 2, ratePaise: 30000 }],
    });
    const d = await as(w.tokens.owner).get(`/purchase-orders/${po.body._id}`);
    expect(d.status).toBe(200);
    expect(d.body.vendorId.name).toBe('Distributor');
    expect(d.body.items[0].productId.name).toBe('Argan Shampoo');
    expect((await as(w.tokens.manager).get(`/purchase-orders/${po.body._id}`)).status).toBe(403);
    expect((await as(w.tokens.manager).get('/purchase-orders')).body).toHaveLength(0);
  });

  it('vendor bill payment status follows the amounts', async () => {
    const v = await Vendor.create({ businessId: w.business._id, name: 'D' });
    const po = await as(w.tokens.owner).post('/purchase-orders', {
      branchId: w.branchA._id.toString(), vendorId: v._id.toString(), items: [{ productId: w.retail._id.toString(), qtyPurchaseUnits: 1, ratePaise: 100 }],
    });
    const b = await as(w.tokens.owner).post(`/purchase-orders/${po.body._id}/bill`, { number: 'X1', amountPaise: 1000, paidPaise: 1000, paymentStatus: 'unpaid' });
    expect(b.body.vendorBill.paymentStatus).toBe('paid');
  });

  it('a transfer receipt must cover every dispatched product', async () => {
    const t = await as(w.tokens.owner).post('/transfers', {
      fromBranchId: w.branchA._id.toString(), toBranchId: w.branchB._id.toString(),
      items: [{ productId: w.retail._id.toString(), pool: 'retail', qty: 2 }, { productId: w.consumable._id.toString(), pool: 'consumable', qty: 10 }],
    });
    await as(w.tokens.owner).post(`/transfers/${t.body._id}/approve`);
    await as(w.tokens.owner).post(`/transfers/${t.body._id}/dispatch`);
    const r = await as(w.tokens.owner).post(`/transfers/${t.body._id}/receive`, { items: [{ productId: w.retail._id.toString(), receivedQty: 2 }] });
    expect(r.status).toBe(422);
  });

  it('a transfer line in a pool the product does not have is rejected', async () => {
    const r = await as(w.tokens.owner).post('/transfers', {
      fromBranchId: w.branchA._id.toString(), toBranchId: w.branchB._id.toString(),
      items: [{ productId: w.retail._id.toString(), pool: 'consumable', qty: 1 }],
    });
    expect(r.status).toBe(422);
  });
});

describe('Phase 3: money', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  const url = (w: World, suffix = '') => `/branches/${w.branchA._id}/closures/${getBusinessDate()}${suffix}`;

  it('till expenses must be cash; future-dated expenses are refused', async () => {
    expect((await as(w.tokens.owner).post(`/branches/${w.branchA._id}/expenses`, { category: 'other', amountPaise: 100, mode: 'upi', paidFrom: 'till' })).status).toBe(422);
    expect((await as(w.tokens.owner).post(`/branches/${w.branchA._id}/expenses`, { category: 'other', amountPaise: 100, mode: 'bank', paidFrom: 'bank', businessDate: '2099-01-01' })).status).toBe(422);
  });

  it('a manager cannot edit another branch\'s expense', async () => {
    const e = await as(w.tokens.owner).post(`/branches/${w.branchB._id}/expenses`, { category: 'other', amountPaise: 100, mode: 'cash', paidFrom: 'till' });
    expect((await as(w.tokens.manager).patch(`/expenses/${e.body._id}`, { amountPaise: 200 })).status).toBe(404);
  });

  it('unknown denominations are a 400; reopening a day that is not approved is a 422', async () => {
    expect((await as(w.tokens.manager).post(url(w, '/submit'), { denominations: { '3': 1 }, cashPaise: 300, upiPaise: 0, cardPaise: 0, diffReason: 'x' })).status).toBe(400);
    await as(w.tokens.manager).get(url(w));
    expect((await as(w.tokens.owner).post(url(w, '/reopen'), { reason: 'x' })).status).toBe(422);
  });

  it('petty cash cannot be added to an approved day', async () => {
    const exp = await as(w.tokens.owner).get(url(w));
    const cash = exp.body.expected?.cashPaise ?? exp.body.existing?.closure?.expected?.cashPaise ?? 500000;
    await as(w.tokens.manager).post(url(w, '/submit'), { denominations: { '500': cash / 50000 }, cashPaise: cash, upiPaise: 0, cardPaise: 0 });
    await as(w.tokens.manager).post(url(w, '/approve'));
    expect((await as(w.tokens.owner).post(`/branches/${w.branchA._id}/petty-cash`, { type: 'topup', amountPaise: 100 })).status).toBe(409);
  });
});

describe('Phase 3: customer plan indexes', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
    await CustomerPlan.syncIndexes();
  });

  it('a business can sell many memberships and packages (only voucher codes are unique)', async () => {
    const m = await createPlan(w.business._id, { type: 'membership', name: 'M', pricePaise: 1000, validityDays: 30, membership: { serviceDiscountBps: 1000 } });
    const p = await createPlan(w.business._id, { type: 'package', name: 'P', pricePaise: 2000, validityDays: 30, package: { items: [{ serviceId: w.haircut._id, sessions: 2 }] } });
    expect((await billIn(w, { lines: [{ kind: 'membership', refId: m._id.toString() }], payments: [{ mode: 'cash', amountPaise: 1180 }] })).status).toBe(201);
    expect((await billIn(w, { lines: [{ kind: 'package', refId: p._id.toString() }], payments: [{ mode: 'cash', amountPaise: 2360 }] })).status).toBe(201);
    expect(await CustomerPlan.countDocuments({ businessId: w.business._id })).toBe(2);
    await expect(
      CustomerPlan.create({ businessId: w.business._id, customerId: w.customer._id, planId: m._id, planSnap: {}, soldBillId: m._id, soldBranchId: w.branchA._id, validFrom: '2026-01-01', validTill: '2026-12-31', voucherCode: 'GV-SAME', status: 'active', log: [] })
    ).resolves.toBeTruthy();
    await expect(
      CustomerPlan.create({ businessId: w.business._id, customerId: w.customer._id, planId: m._id, planSnap: {}, soldBillId: m._id, soldBranchId: w.branchA._id, validFrom: '2026-01-01', validTill: '2026-12-31', voucherCode: 'GV-SAME', status: 'active', log: [] })
    ).rejects.toThrow(/duplicate key/i);
  });
});
