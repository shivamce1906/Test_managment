import '../helpers/testEnv';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, World } from '../helpers/factory';
import { StockBalance, StockMovement, Vendor, AuditLog } from '../../src/models';

const qty = async (w: World, productId: any, pool: string, branch: any = w.branchA) =>
  (await StockBalance.findOne({ businessId: w.business._id, branchId: branch._id, productId, pool }))?.qty ?? 0;

async function vendor(w: World) {
  return Vendor.create({ businessId: w.business._id, name: 'L\'Oreal Distributor' });
}
async function approvedPo(w: World, qtyUnits = 5) {
  const v = await vendor(w);
  const po = await as(w.tokens.manager).post('/purchase-orders', {
    branchId: w.branchA._id.toString(), vendorId: v._id.toString(),
    items: [{ productId: w.consumable._id.toString(), qtyPurchaseUnits: qtyUnits, ratePaise: 50000 }],
  });
  expect(po.status).toBe(201);
  const ap = await as(w.tokens.manager).post(`/purchase-orders/${po.body._id}/decide`, { decision: 'approve' });
  expect(ap.status).toBe(200);
  return po.body;
}

describe('Inventory — stock and adjustments (PRD §10)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('lists branch stock by pool', async () => {
    const res = await as(w.tokens.owner).get(`/branches/${w.branchA._id}/stock`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(String(w.retail._id));
  });

  it('adjustment with reason changes stock and writes a movement + audit', async () => {
    const res = await as(w.tokens.manager).post(`/branches/${w.branchA._id}/stock/adjust`, {
      productId: w.retail._id.toString(), pool: 'retail', qty: -2, reason: 'Damaged in transit',
    });
    expect([200, 201]).toContain(res.status);
    expect(await qty(w, w.retail._id, 'retail')).toBe(8);
    expect(await StockMovement.findOne({ businessId: w.business._id, type: 'adjust', reason: 'Damaged in transit' })).toBeTruthy();
    expect(await AuditLog.findOne({ businessId: w.business._id, action: /stock/ })).toBeTruthy();
  });

  it('adjustment without reason or with qty 0 -> 400', async () => {
    expect((await as(w.tokens.manager).post(`/branches/${w.branchA._id}/stock/adjust`, { productId: w.retail._id.toString(), pool: 'retail', qty: -1 })).status).toBe(400);
    expect((await as(w.tokens.manager).post(`/branches/${w.branchA._id}/stock/adjust`, { productId: w.retail._id.toString(), pool: 'retail', qty: 0, reason: 'x' })).status).toBe(400);
  });

  it('internal use deducts consumable stock', async () => {
    await as(w.tokens.manager).post(`/branches/${w.branchA._id}/stock/adjust`, {
      productId: w.consumable._id.toString(), pool: 'consumable', qty: -50, reason: 'Training session', type: 'internal_use',
    });
    expect(await qty(w, w.consumable._id, 'consumable')).toBe(450);
  });

  it('cannot adjust a retail-only product in the consumable pool', async () => {
    const res = await as(w.tokens.manager).post(`/branches/${w.branchA._id}/stock/adjust`, {
      productId: w.retail._id.toString(), pool: 'consumable', qty: 5, reason: 'x',
    });
    expect([400, 422]).toContain(res.status);
  });

  it('stock balance always equals the sum of its movements (opening stock aside)', async () => {
    await as(w.tokens.manager).post(`/branches/${w.branchA._id}/stock/adjust`, { productId: w.retail._id.toString(), pool: 'retail', qty: 5, reason: 'found' });
    await as(w.tokens.manager).post(`/branches/${w.branchA._id}/stock/adjust`, { productId: w.retail._id.toString(), pool: 'retail', qty: -3, reason: 'lost' });
    const mv = await StockMovement.find({ businessId: w.business._id, productId: w.retail._id });
    expect(10 + mv.reduce((a, m) => a + m.qty, 0)).toBe(await qty(w, w.retail._id, 'retail'));
  });
});

describe('Inventory — purchase orders', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('PO is created pending approval with a PO number and total', async () => {
    const v = await vendor(w);
    const res = await as(w.tokens.manager).post('/purchase-orders', {
      branchId: w.branchA._id.toString(), vendorId: v._id.toString(),
      items: [{ productId: w.consumable._id.toString(), qtyPurchaseUnits: 5, ratePaise: 50000 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending_approval');
    expect(res.body.poNo).toMatch(/^PO-SRT1-0001$/);
    expect(res.body.totalPaise).toBe(250000);
  });

  it('cannot receive before approval', async () => {
    const v = await vendor(w);
    const po = await as(w.tokens.manager).post('/purchase-orders', {
      branchId: w.branchA._id.toString(), vendorId: v._id.toString(),
      items: [{ productId: w.consumable._id.toString(), qtyPurchaseUnits: 5, ratePaise: 50000 }],
    });
    const res = await as(w.tokens.manager).post(`/purchase-orders/${po.body._id}/receive`, { items: [{ productId: w.consumable._id.toString(), qty: 5 }] });
    expect([400, 422]).toContain(res.status);
  });

  it('partial then full receipt converts purchase units to use units (5 tubes × 100 ml)', async () => {
    const po = await approvedPo(w);
    const r1 = await as(w.tokens.manager).post(`/purchase-orders/${po._id}/receive`, { items: [{ productId: w.consumable._id.toString(), qty: 2, batch: 'B1', expiry: '2027-06-30' }] });
    expect(r1.body.status).toBe('partly_received');
    expect(await qty(w, w.consumable._id, 'consumable')).toBe(700);
    const r2 = await as(w.tokens.manager).post(`/purchase-orders/${po._id}/receive`, { items: [{ productId: w.consumable._id.toString(), qty: 3 }] });
    expect(r2.body.status).toBe('received');
    expect(await qty(w, w.consumable._id, 'consumable')).toBe(1000);
  });

  it('EDGE: cannot receive more than ordered', async () => {
    const po = await approvedPo(w, 5);
    const res = await as(w.tokens.manager).post(`/purchase-orders/${po._id}/receive`, { items: [{ productId: w.consumable._id.toString(), qty: 50 }] });
    expect([400, 422]).toContain(res.status);
  });

  it('purchase movement cost is an integer total in paise (Database Design: "rounded once")', async () => {
    const po = await approvedPo(w, 1);
    await as(w.tokens.manager).post(`/purchase-orders/${po._id}/receive`, { items: [{ productId: w.consumable._id.toString(), qty: 1 }] });
    const mv = await StockMovement.findOne({ businessId: w.business._id, type: 'purchase' });
    expect(Number.isInteger(mv!.costPaise)).toBe(true);
    expect(mv!.costPaise).toBe(50000);
  });

  it('rejected PO cannot be received', async () => {
    const v = await vendor(w);
    const po = await as(w.tokens.manager).post('/purchase-orders', {
      branchId: w.branchA._id.toString(), vendorId: v._id.toString(),
      items: [{ productId: w.consumable._id.toString(), qtyPurchaseUnits: 5, ratePaise: 50000 }],
    });
    await as(w.tokens.manager).post(`/purchase-orders/${po.body._id}/decide`, { decision: 'reject', reason: 'Too expensive' });
    const res = await as(w.tokens.manager).post(`/purchase-orders/${po.body._id}/receive`, { items: [{ productId: w.consumable._id.toString(), qty: 5 }] });
    expect([400, 422]).toContain(res.status);
  });

  it('manager without approvePO cannot approve', async () => {
    const w2 = await seedWorld({ managerFlags: { approvePO: false } });
    const v = await vendor(w2);
    const po = await as(w2.tokens.manager).post('/purchase-orders', {
      branchId: w2.branchA._id.toString(), vendorId: v._id.toString(),
      items: [{ productId: w2.consumable._id.toString(), qtyPurchaseUnits: 1, ratePaise: 100 }],
    });
    expect((await as(w2.tokens.manager).post(`/purchase-orders/${po.body._id}/decide`, { decision: 'approve' })).status).toBe(403);
  });

  it('manager cannot raise a PO for a branch they do not manage', async () => {
    const v = await vendor(w);
    const res = await as(w.tokens.manager).post('/purchase-orders', {
      branchId: w.branchB._id.toString(), vendorId: v._id.toString(),
      items: [{ productId: w.consumable._id.toString(), qtyPurchaseUnits: 1, ratePaise: 100 }],
    });
    expect([403, 404]).toContain(res.status);
  });

  it('PO with another business\'s vendor or product is rejected', async () => {
    const foreignVendor = await Vendor.create({ businessId: w.otherBusiness._id, name: 'Foreign' });
    const res = await as(w.tokens.owner).post('/purchase-orders', {
      branchId: w.branchA._id.toString(), vendorId: foreignVendor._id.toString(),
      items: [{ productId: w.consumable._id.toString(), qtyPurchaseUnits: 1, ratePaise: 100 }],
    });
    expect([404, 422]).toContain(res.status);
  });

  it('vendor bill and payment status recorded', async () => {
    const po = await approvedPo(w);
    const res = await as(w.tokens.owner).post(`/purchase-orders/${po._id}/bill`, { number: 'INV-77', amountPaise: 250000, paymentStatus: 'partly_paid', paidPaise: 100000 });
    expect(res.status).toBe(200);
    expect(res.body.vendorBill).toMatchObject({ number: 'INV-77', paymentStatus: 'partly_paid', paidPaise: 100000 });
  });

  it('EDGE: vendor bill paid amount cannot exceed bill amount', async () => {
    const po = await approvedPo(w);
    const res = await as(w.tokens.owner).post(`/purchase-orders/${po._id}/bill`, { number: 'INV-78', amountPaise: 1000, paymentStatus: 'paid', paidPaise: 999999 });
    expect([400, 422]).toContain(res.status);
  });
});

describe('Inventory — inter-branch transfers', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  const create = (w: World, q = 4) =>
    as(w.tokens.owner).post('/transfers', {
      fromBranchId: w.branchA._id.toString(), toBranchId: w.branchB._id.toString(),
      items: [{ productId: w.retail._id.toString(), pool: 'retail', qty: q }],
    });

  it('request -> approve -> dispatch (sender -) -> receive (receiver +)', async () => {
    const t = await create(w);
    expect(t.status).toBe(201);
    expect(t.body.status).toBe('requested');
    expect((await as(w.tokens.owner).post(`/transfers/${t.body._id}/approve`)).body.status).toBe('approved');
    expect((await as(w.tokens.owner).post(`/transfers/${t.body._id}/dispatch`)).body.status).toBe('dispatched');
    expect(await qty(w, w.retail._id, 'retail')).toBe(6);
    expect(await qty(w, w.retail._id, 'retail', w.branchB)).toBe(0);
    const rc = await as(w.tokens.owner).post(`/transfers/${t.body._id}/receive`, { items: [{ productId: w.retail._id.toString(), receivedQty: 4 }] });
    expect(rc.body.status).toBe('received');
    expect(await qty(w, w.retail._id, 'retail', w.branchB)).toBe(4);
  });

  it('mismatch on receipt is recorded with reason', async () => {
    const t = await create(w);
    await as(w.tokens.owner).post(`/transfers/${t.body._id}/approve`);
    await as(w.tokens.owner).post(`/transfers/${t.body._id}/dispatch`);
    const rc = await as(w.tokens.owner).post(`/transfers/${t.body._id}/receive`, { items: [{ productId: w.retail._id.toString(), receivedQty: 3, mismatchReason: 'One broken' }] });
    expect(rc.body.items[0]).toMatchObject({ receivedQty: 3, mismatchReason: 'One broken' });
    expect(await qty(w, w.retail._id, 'retail', w.branchB)).toBe(3);
  });

  it('EDGE: receiving MORE than dispatched is rejected', async () => {
    const t = await create(w);
    await as(w.tokens.owner).post(`/transfers/${t.body._id}/approve`);
    await as(w.tokens.owner).post(`/transfers/${t.body._id}/dispatch`);
    const rc = await as(w.tokens.owner).post(`/transfers/${t.body._id}/receive`, { items: [{ productId: w.retail._id.toString(), receivedQty: 400 }] });
    expect([400, 422]).toContain(rc.status);
  });

  it('EDGE: a short receipt without a mismatch reason is rejected', async () => {
    const t = await create(w);
    await as(w.tokens.owner).post(`/transfers/${t.body._id}/approve`);
    await as(w.tokens.owner).post(`/transfers/${t.body._id}/dispatch`);
    const rc = await as(w.tokens.owner).post(`/transfers/${t.body._id}/receive`, { items: [{ productId: w.retail._id.toString(), receivedQty: 1 }] });
    expect([400, 422]).toContain(rc.status);
  });

  it('cannot dispatch more than the sender has', async () => {
    const t = await create(w, 50);
    await as(w.tokens.owner).post(`/transfers/${t.body._id}/approve`);
    const d = await as(w.tokens.owner).post(`/transfers/${t.body._id}/dispatch`);
    expect([400, 422]).toContain(d.status);
    expect(await qty(w, w.retail._id, 'retail')).toBe(10);
  });

  it('cannot dispatch before approval or receive before dispatch', async () => {
    const t = await create(w);
    expect([400, 422]).toContain((await as(w.tokens.owner).post(`/transfers/${t.body._id}/dispatch`)).status);
    await as(w.tokens.owner).post(`/transfers/${t.body._id}/approve`);
    expect([400, 422]).toContain((await as(w.tokens.owner).post(`/transfers/${t.body._id}/receive`, { items: [{ productId: w.retail._id.toString(), receivedQty: 4 }] })).status);
  });

  it('receiving twice does not double the stock', async () => {
    const t = await create(w);
    await as(w.tokens.owner).post(`/transfers/${t.body._id}/approve`);
    await as(w.tokens.owner).post(`/transfers/${t.body._id}/dispatch`);
    await as(w.tokens.owner).post(`/transfers/${t.body._id}/receive`, { items: [{ productId: w.retail._id.toString(), receivedQty: 4 }] });
    await as(w.tokens.owner).post(`/transfers/${t.body._id}/receive`, { items: [{ productId: w.retail._id.toString(), receivedQty: 4 }] });
    expect(await qty(w, w.retail._id, 'retail', w.branchB)).toBe(4);
  });

  it('same from/to branch -> 400', async () => {
    const res = await as(w.tokens.owner).post('/transfers', {
      fromBranchId: w.branchA._id.toString(), toBranchId: w.branchA._id.toString(),
      items: [{ productId: w.retail._id.toString(), pool: 'retail', qty: 1 }],
    });
    expect(res.status).toBe(400);
  });

  it('cannot transfer to a branch of another business', async () => {
    const res = await as(w.tokens.owner).post('/transfers', {
      fromBranchId: w.branchA._id.toString(), toBranchId: w.otherBranch._id.toString(),
      items: [{ productId: w.retail._id.toString(), pool: 'retail', qty: 1 }],
    });
    expect([403, 404]).toContain(res.status);
  });

  it('manager of the RECEIVING branch only cannot approve (PRD: approver = sending branch)', async () => {
    const t = await as(w.tokens.owner).post('/transfers', {
      fromBranchId: w.branchB._id.toString(), toBranchId: w.branchA._id.toString(),
      items: [{ productId: w.retail._id.toString(), pool: 'retail', qty: 1 }],
    });
    const res = await as(w.tokens.manager).post(`/transfers/${t.body._id}/approve`);
    expect(res.status).toBe(403);
  });
});

describe('Inventory — stock audit', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('count sheet -> variance -> owner approval posts audit movements', async () => {
    const a = await as(w.tokens.manager).post(`/branches/${w.branchA._id}/stock-audits`, { pool: 'retail' });
    expect(a.status).toBe(201);
    const line = a.body.lines.find((l: any) => String(l.productId) === String(w.retail._id));
    expect(line.systemQty).toBe(10);
    const c = await as(w.tokens.manager).patch(`/stock-audits/${a.body._id}/counts`, { lines: [{ productId: w.retail._id.toString(), countedQty: 7 }] });
    expect(c.status).toBe(200);
    const ap = await as(w.tokens.owner).post(`/stock-audits/${a.body._id}/approve`);
    expect(ap.status).toBe(200);
    expect(await qty(w, w.retail._id, 'retail')).toBe(7);
    expect((await StockMovement.findOne({ businessId: w.business._id, type: 'audit' }))?.qty).toBe(-3);
  });

  it('negative counted quantity -> 400', async () => {
    const a = await as(w.tokens.manager).post(`/branches/${w.branchA._id}/stock-audits`, { pool: 'retail' });
    const c = await as(w.tokens.manager).patch(`/stock-audits/${a.body._id}/counts`, { lines: [{ productId: w.retail._id.toString(), countedQty: -5 }] });
    expect(c.status).toBe(400);
  });

  it('approving twice does not post the variance twice', async () => {
    const a = await as(w.tokens.manager).post(`/branches/${w.branchA._id}/stock-audits`, { pool: 'retail' });
    await as(w.tokens.manager).patch(`/stock-audits/${a.body._id}/counts`, { lines: [{ productId: w.retail._id.toString(), countedQty: 7 }] });
    await as(w.tokens.owner).post(`/stock-audits/${a.body._id}/approve`);
    await as(w.tokens.owner).post(`/stock-audits/${a.body._id}/approve`);
    expect(await qty(w, w.retail._id, 'retail')).toBe(7);
  });

  it('manager may approve a stock audit (Backend SRS: approve O, M)', async () => {
    const a = await as(w.tokens.manager).post(`/branches/${w.branchA._id}/stock-audits`, { pool: 'retail' });
    await as(w.tokens.manager).patch(`/stock-audits/${a.body._id}/counts`, { lines: [{ productId: w.retail._id.toString(), countedQty: 9 }] });
    expect((await as(w.tokens.manager).post(`/stock-audits/${a.body._id}/approve`)).status).toBe(200);
  });
});
