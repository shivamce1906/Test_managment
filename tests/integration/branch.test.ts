import '../helpers/testEnv';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, serviceLine, World } from '../helpers/factory';
import { Vendor } from '../../src/models';
import { getBusinessDate } from '../../src/utils';

describe('Branch login: front desk', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld({ gst: false });
  });

  it('bills need Billed by; edit, cancel, refund and approvals stay closed', async () => {
    const b = () => as(w.tokens.branchA);
    const A = w.branchA._id.toString();
    const noName = await b().post(`/branches/${A}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 100000 }],
    });
    expect(noName.status).toBe(400);
    expect(noName.body.error.fields.billedByStaffId).toBe('Choose who is billing');

    const bill = await b().post(`/branches/${A}/bills`, {
      customerId: w.customer._id.toString(), billedByStaffId: w.receptionist._id.toString(),
      lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 100000 }],
    });
    expect(bill.status).toBe(201);
    expect((await b().post(`/bills/${bill.body._id}/cancel`, { reason: 'x' })).status).toBe(403);
    expect((await b().patch(`/bills/${bill.body._id}`, { notes: 'x' })).status).toBe(403);
    expect((await b().get('/approvals')).status).toBe(403);

    const held = await b().post(`/branches/${A}/bills`, {
      customerId: w.customer._id.toString(), billedByStaffId: w.receptionist._id.toString(),
      lines: [serviceLine(w.haircut._id, w.stylist1._id)], billDiscount: { type: 'pct', value: 2000 }, payments: [{ mode: 'cash', amountPaise: 80000 }],
    });
    expect(held.body.status).toBe('awaiting_approval'); // 20 % is above the 10 % branch limit
  });

  it('dashboard is the own day summary only', async () => {
    const d = await as(w.tokens.branchA).get('/dashboard');
    expect(d.status).toBe(200);
    expect(d.body.today).toBeDefined();
    expect(d.body).not.toHaveProperty('mtd');
    expect(d.body).not.toHaveProperty('last7Days');
    expect((await as(w.tokens.owner).get('/dashboard')).body).toHaveProperty('mtd');
    expect((await as(w.tokens.branchA).get(`/dashboard?branchId=${w.branchB._id}`)).status).toBe(403);
  });
});

describe('Branch login: staff are names only', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld({ gst: false });
  });

  it('lists, details, attendance and leave carry no salary, commission or contact details', async () => {
    const b = () => as(w.tokens.branchA);
    const hidden = ['salary', 'commission', 'statutory', 'bankRef', 'documents', 'emergencyContact', 'phone', 'joiningDate'];

    const list = await b().get('/staff');
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThan(0);
    for (const s of list.body) for (const k of hidden) expect([s.name, k, s[k]]).toEqual([s.name, k, undefined]);
    expect(list.body[0]).toMatchObject({ name: expect.any(String), designation: expect.any(String) });

    const one = await b().get(`/staff/${w.stylist1._id}`);
    expect(one.body.name).toBe('Sam Stylist');
    for (const k of hidden) expect(one.body[k]).toBeUndefined();

    const att = await b().get(`/staff/branches/${w.branchA._id}/attendance`);
    for (const row of att.body) expect(row.staff.salary).toBeUndefined();

    expect((await b().get(`/staff/branches/${w.branchA._id}/billed-by`)).body[0]).not.toHaveProperty('phone');
    expect((await b().get(`/staff/branches/${w.branchA._id}/advances`)).status).toBe(403);
    expect((await b().get(`/staff/${w.stylistB._id}`)).status).toBe(404);

    // owners and managers still get the full record
    expect((await as(w.tokens.manager).get(`/staff/${w.stylist1._id}`)).body.salary).toBeDefined();
  });
});

describe('Branch login: stock', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld({ gst: false });
  });

  it('sees quantities and selling prices, never purchase cost or stock value', async () => {
    const b = () => as(w.tokens.branchA);
    const products = await b().get('/products');
    expect(products.body[0].sellingPricePaise).toBeDefined();
    for (const p of products.body) expect(p.purchasePricePaise).toBeUndefined();

    const stock = await b().get(`/branches/${w.branchA._id}/stock`);
    expect(stock.body[0].qty).toBeDefined();
    for (const r of stock.body) {
      expect(r.valuePaise).toBeUndefined();
      expect(r.productId.purchasePricePaise).toBeUndefined();
    }
    expect((await as(w.tokens.owner).get(`/branches/${w.branchA._id}/stock`)).body[0].valuePaise).toBeDefined();
  });

  it('records internal use only; other adjustments stay with the manager', async () => {
    const url = `/branches/${w.branchA._id}/stock/adjust`;
    const use = await as(w.tokens.branchA).post(url, { productId: w.consumable._id.toString(), pool: 'consumable', qty: -20, type: 'internal_use', reason: 'Back-bar shampoo' });
    expect(use.status).toBe(201);
    expect(use.body.balance.qty).toBe(480);
    expect(use.body.movement.costPaise).toBeUndefined();

    const adj = await as(w.tokens.branchA).post(url, { productId: w.retail._id.toString(), pool: 'retail', qty: -1, reason: 'Damaged' });
    expect(adj.status).toBe(403);
    expect((await as(w.tokens.branchA).post(`/branches/${w.branchB._id}/stock/adjust`, { productId: w.consumable._id.toString(), pool: 'consumable', qty: -1, type: 'internal_use', reason: 'x' })).status).toBe(403);
  });

  it('raises and receives purchase orders for its own branch; approving stays with the manager', async () => {
    const v = await Vendor.create({ businessId: w.business._id, name: 'Distributor' });
    const b = () => as(w.tokens.branchA);
    const po = await b().post('/purchase-orders', {
      branchId: w.branchA._id.toString(), vendorId: v._id.toString(),
      items: [{ productId: w.retail._id.toString(), qtyPurchaseUnits: 2, ratePaise: 30000 }],
    });
    expect(po.status).toBe(201);
    expect(po.body.status).toBe('pending_approval');
    expect((await b().post(`/purchase-orders/${po.body._id}/decide`, { decision: 'approve' })).status).toBe(403);

    expect((await as(w.tokens.manager).post(`/purchase-orders/${po.body._id}/decide`, { decision: 'approve' })).status).toBe(200);
    const rec = await b().post(`/purchase-orders/${po.body._id}/receive`, { items: [{ productId: w.retail._id.toString(), qty: 2 }] });
    expect(rec.status).toBe(200);
    expect(rec.body.status).toBe('received');
    expect(rec.body).not.toHaveProperty('vendorBill');
    expect((await b().post(`/purchase-orders/${po.body._id}/bill`, { number: 'X1', amountPaise: 60000, paidPaise: 0, paymentStatus: 'unpaid' })).status).toBe(403);

    const list = await b().get('/purchase-orders');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].items[0].ratePaise).toBe(30000);

    expect((await b().post('/purchase-orders', {
      branchId: w.branchB._id.toString(), vendorId: v._id.toString(), items: [{ productId: w.retail._id.toString(), qtyPurchaseUnits: 1, ratePaise: 100 }],
    })).status).toBe(403);
  });

  it('the branch directory lists every active branch by name only, for the "request from" picker', async () => {
    const dir = await as(w.tokens.branchA).get('/business/branches/directory');
    expect(dir.status).toBe(200);
    expect(dir.body.map((x: any) => x.code)).toEqual(['SRT1', 'SRT2']);
    expect(Object.keys(dir.body[0]).sort()).toEqual(['_id', 'code', 'name', 'status']);
    expect((await as(w.tokens.branchA).get('/business/branches')).body).toHaveLength(1);
  });

  it('requests a transfer into its own branch and receives it; the sender approves and dispatches', async () => {
    const t = await as(w.tokens.branchB).post('/transfers', {
      fromBranchId: w.branchA._id.toString(), toBranchId: w.branchB._id.toString(), items: [{ productId: w.retail._id.toString(), pool: 'retail', qty: 2 }],
    });
    expect(t.status).toBe(201);
    expect((await as(w.tokens.branchB).post(`/transfers/${t.body._id}/approve`)).status).toBe(403);
    expect((await as(w.tokens.branchA).post(`/transfers/${t.body._id}/dispatch`)).status).toBe(403);

    await as(w.tokens.manager).post(`/transfers/${t.body._id}/approve`);
    await as(w.tokens.manager).post(`/transfers/${t.body._id}/dispatch`);
    const r = await as(w.tokens.branchB).post(`/transfers/${t.body._id}/receive`, { items: [{ productId: w.retail._id.toString(), receivedQty: 2 }] });
    expect(r.status).toBe(200);
    expect((await as(w.tokens.branchB).get('/transfers')).body).toHaveLength(1);

    const push = await as(w.tokens.branchA).post('/transfers', {
      fromBranchId: w.branchA._id.toString(), toBranchId: w.branchB._id.toString(), items: [{ productId: w.retail._id.toString(), pool: 'retail', qty: 1 }],
    });
    expect(push.status).toBe(403);
  });

  it('enters stock-audit counts; approving stays with the manager', async () => {
    const b = () => as(w.tokens.branchA);
    const audit = await b().post(`/branches/${w.branchA._id}/stock-audits`, { pool: 'retail' });
    expect(audit.status).toBe(201);
    const counts = await b().patch(`/stock-audits/${audit.body._id}/counts`, { lines: [{ productId: w.retail._id.toString(), countedQty: 9 }] });
    expect(counts.status).toBe(200);
    expect((await b().post(`/stock-audits/${audit.body._id}/approve`)).status).toBe(403);
    expect((await as(w.tokens.manager).post(`/stock-audits/${audit.body._id}/approve`)).status).toBe(200);
  });
});

describe('Branch login: money and team', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld({ gst: false });
  });

  it('adds expenses; editing, deleting, approving the day, payroll, reports and audit are closed', async () => {
    const b = () => as(w.tokens.branchA);
    const A = w.branchA._id.toString();
    const e = await b().post(`/branches/${A}/expenses`, { category: 'tea_snacks', amountPaise: 2000, mode: 'cash', paidFrom: 'till' });
    expect(e.status).toBe(201);
    expect((await b().patch(`/expenses/${e.body._id}`, { amountPaise: 1 })).status).toBe(403);
    expect((await b().delete(`/expenses/${e.body._id}`)).status).toBe(403);
    expect((await b().post(`/branches/${A}/closures/${getBusinessDate()}/approve`)).status).toBe(403);
    expect((await b().get(`/branches/${A}/payroll-runs`)).status).toBe(403);
    expect((await b().get('/reports/sales-summary')).status).toBe(403);
    expect((await b().get('/audit-logs')).status).toBe(403);
    expect((await b().get(`/staff/${w.stylist1._id}/roster`)).status).toBe(200);
    expect((await b().patch(`/staff/${w.stylist1._id}/roster`, { weekly: [] })).status).toBe(403);
  });
});
