import '../helpers/testEnv';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, World, serviceLine, dayOffset, createStaff } from '../helpers/factory';
import {
  Bill, StockBalance, StockMovement, Customer, DailySummary, AuditLog, Due, DayClosure, Branch, Service, Counter, User,
} from '../../src/models';
import { getBusinessDate, getFinancialYear } from '../../src/utils';

const fy = () => getFinancialYear(new Date(), 4);
const stock = async (w: World, productId: any, pool: string, branch = w.branchA) =>
  (await StockBalance.findOne({ businessId: w.business._id, branchId: branch._id, productId, pool }))?.qty;
const cust = (w: World) => Customer.findOne({ _id: w.customer._id, businessId: w.business._id });

const branchBill = (w: World, extra: any = {}) => ({
  customerId: w.customer._id.toString(),
  billedByStaffId: w.receptionist._id.toString(),
  lines: [serviceLine(w.haircut._id, w.stylist1._id)],
  payments: [{ mode: 'cash', amountPaise: 118000 }],
  ...extra,
});

describe('Billing — create bill (PRD §7, Backend SRS §8)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('branch login raises a paid GST bill with correct totals', async () => {
    const res = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('paid');
    expect(res.body.totals).toMatchObject({ taxablePaise: 100000, cgstPaise: 9000, sgstPaise: 9000, totalPaise: 118000, duePaise: 0 });
    expect(res.body.gstApplied).toBe(true);
  });

  it('invoice numbers follow PREFIX/FY/000001 and increase per branch', async () => {
    const b1 = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w));
    const b2 = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w));
    expect(b1.body.invoiceNo).toBe(`SRT1/${fy()}/000001`);
    expect(b2.body.invoiceNo).toBe(`SRT1/${fy()}/000002`);
  });

  it('each branch has its own invoice sequence', async () => {
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, branchBill(w));
    const bB = await as(w.tokens.owner).post(`/branches/${w.branchB._id}/bills`, branchBill(w, { lines: [serviceLine(w.haircut._id, w.stylistB._id)] }));
    expect(bB.body.invoiceNo).toBe(`SRT2/${fy()}/000001`);
  });

  it('branch login must pick a "Billed by" receptionist', async () => {
    const res = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w, { billedByStaffId: undefined }));
    expect(res.status).toBe(400);
  });

  it('"Billed by" must be a receptionist of this branch (a stylist is rejected)', async () => {
    const res = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w, { billedByStaffId: w.stylist1._id.toString() }));
    expect(res.status).toBe(400);
  });

  it('records Billed-by name on the bill and in the audit log', async () => {
    const res = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w));
    expect(res.body.billedByName).toBe('Riya Reception');
    const log = await AuditLog.findOne({ businessId: w.business._id, action: 'bill.create', entityId: res.body._id });
    expect(log?.billedByName).toBe('Riya Reception');
  });

  it('snapshots the staff name on the service line (Database Design §1 "Snapshot names")', async () => {
    const res = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w));
    expect(res.body.lines[0].staff[0].name).toBe('Sam Stylist');
  });

  it('computes and stores staff commission on the line (10% of ₹1,000 = ₹100)', async () => {
    const res = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w));
    expect(res.body.lines[0].staff[0].commissionPaise).toBe(10000);
  });

  it('falls back to the staff member\'s default commission when the service has none', async () => {
    await Service.updateOne({ _id: w.haircut._id, businessId: w.business._id }, { $unset: { commission: 1 } });
    // stylist1 default = 10%
    const res = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w));
    expect(res.body.lines[0].staff[0].commissionPaise).toBe(10000);
  });

  it('product sales commission uses the staff member\'s productBps (5%)', async () => {
    const res = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(),
      lines: [{ kind: 'product', refId: w.retail._id.toString(), qty: 1, staff: [{ staffId: w.stylist1._id.toString(), splitBps: 10000 }] }],
      payments: [{ mode: 'cash', amountPaise: 59000 }],
    });
    expect(res.body.lines[0].staff[0].commissionPaise).toBe(2500);
  });

  it('staff splits must total 100% -> 422 SPLIT_INVALID', async () => {
    const res = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w, {
      lines: [{ ...serviceLine(w.haircut._id), staff: [{ staffId: w.stylist1._id.toString(), splitBps: 5000 }, { staffId: w.stylist2._id.toString(), splitBps: 4000 }] }],
    }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SPLIT_INVALID');
  });

  it('rejects a staff member from another business on a bill line', async () => {
    const foreign = await createStaff(w.otherBusiness._id, w.otherBranch._id, { name: 'Foreign' });
    const res = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w, { lines: [serviceLine(w.haircut._id, foreign._id)] }));
    expect([404, 422]).toContain(res.status);
  });

  it('uses the branch-wise price override', async () => {
    await Service.updateOne(
      { _id: w.haircut._id, businessId: w.business._id },
      { $set: { branchPrices: [{ branchId: w.branchA._id, pricePaise: 120000, active: true }] } }
    );
    const a = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, branchBill(w, { payments: [{ mode: 'cash', amountPaise: 141600 }] }));
    const b = await as(w.tokens.owner).post(`/branches/${w.branchB._id}/bills`, branchBill(w, { lines: [serviceLine(w.haircut._id, w.stylistB._id)] }));
    expect(a.body.lines[0].unitPricePaise).toBe(120000);
    expect(b.body.lines[0].unitPricePaise).toBe(100000);
  });

  it('a service deactivated for this branch cannot be billed there', async () => {
    await Service.updateOne(
      { _id: w.haircut._id, businessId: w.business._id },
      { $set: { branchPrices: [{ branchId: w.branchA._id, active: false }] } }
    );
    const res = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w));
    expect([404, 422]).toContain(res.status);
  });

  it('GST-off business issues a plain bill (no tax)', async () => {
    const w2 = await seedWorld({ gst: false });
    const res = await as(w2.tokens.owner).post(`/branches/${w2.branchA._id}/bills`, {
      customerId: w2.customer._id.toString(), lines: [serviceLine(w2.haircut._id, w2.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 100000 }],
    });
    expect(res.body.gstApplied).toBe(false);
    expect(res.body.totals.totalPaise).toBe(100000);
  });

  it('EDGE: payments larger than the bill are rejected (payments must equal total + tips - due)', async () => {
    const res = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w, { payments: [{ mode: 'upi', amountPaise: 500000 }] }));
    expect([400, 422]).toContain(res.status);
  });

  it('cash tendered greater than due is fine (change is returned, payment = payable)', async () => {
    const res = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w, { payments: [{ mode: 'cash', amountPaise: 118000, tenderedPaise: 200000 }] }));
    expect(res.status).toBe(201);
    expect(res.body.payments[0].tenderedPaise).toBe(200000);
  });

  it('tips are stored per staff and added to payable, not to sales', async () => {
    const res = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w, {
      tips: [{ staffId: w.stylist1._id.toString(), amountPaise: 10000, payout: 'payroll' }],
      payments: [{ mode: 'cash', amountPaise: 128000 }],
    }));
    expect(res.body.status).toBe('paid');
    expect(res.body.totals.totalPaise).toBe(118000);
    expect(res.body.tips[0]).toMatchObject({ amountPaise: 10000, payout: 'payroll' });
  });

  it('inactive / unknown service -> 404', async () => {
    await Service.updateOne({ _id: w.haircut._id, businessId: w.business._id }, { $set: { active: false } });
    const res = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w));
    expect(res.status).toBe(404);
  });

  it('empty bill (no lines) -> 400', async () => {
    const res = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w, { lines: [] }));
    expect(res.status).toBe(400);
  });

  it('negative / fractional payment amounts -> 400', async () => {
    expect((await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w, { payments: [{ mode: 'cash', amountPaise: -100 }] }))).status).toBe(400);
    expect((await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w, { payments: [{ mode: 'cash', amountPaise: 10.5 }] }))).status).toBe(400);
  });

  it('bill on an approved (closed) day is blocked with 409 DAY_CLOSED', async () => {
    await DayClosure.create({
      businessId: w.business._id, branchId: w.branchA._id, businessDate: getBusinessDate(),
      expected: { cashPaise: 0, upiPaise: 0, cardPaise: 0 }, status: 'approved',
    });
    const res = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DAY_CLOSED');
  });

  it('bill in a deactivated branch is blocked with 422 BRANCH_INACTIVE', async () => {
    await Branch.updateOne({ _id: w.branchA._id, businessId: w.business._id }, { $set: { status: 'deactivated' } });
    const res = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, branchBill(w));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BRANCH_INACTIVE');
  });

  it('Idempotency-Key header: same key twice returns the same bill, not a duplicate', async () => {
    const send = () => as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w)).set('Idempotency-Key', 'tap-123');
    const r1 = await send();
    const r2 = await send();
    expect(r2.body._id).toBe(r1.body._id);
    expect(await Bill.countDocuments({ businessId: w.business._id })).toBe(1);
  });
});

describe('Billing — side effects of a paid bill', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('retail product sale deducts retail stock and posts a sale movement', async () => {
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(),
      lines: [{ kind: 'product', refId: w.retail._id.toString(), qty: 2 }],
      payments: [{ mode: 'cash', amountPaise: 118000 }],
    });
    expect(await stock(w, w.retail._id, 'retail')).toBe(8);
    const mv = await StockMovement.findOne({ businessId: w.business._id, productId: w.retail._id, type: 'sale' });
    expect(mv?.qty).toBe(-2);
  });

  it('service auto-deducts its consumables (30 ml colour per Global Colour)', async () => {
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.colour._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 295000 }],
    });
    expect(await stock(w, w.consumable._id, 'consumable')).toBe(470);
  });

  it('consumable movement records a cost (PRD §15 service margin needs consumable cost)', async () => {
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.colour._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 295000 }],
    });
    const mv = await StockMovement.findOne({ businessId: w.business._id, productId: w.consumable._id, type: 'service_use' });
    // ₹500 per 100 ml tube -> 30 ml = ₹150
    expect(mv?.costPaise).toBe(15000);
  });

  it('stock may go negative instead of blocking the bill (PRD §10)', async () => {
    const res = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(),
      lines: [{ kind: 'product', refId: w.retail._id.toString(), qty: 12 }],
      payments: [{ mode: 'cash', amountPaise: 708000 }],
    });
    expect(res.status).toBe(201);
    expect(await stock(w, w.retail._id, 'retail')).toBe(-2);
  });

  it('updates customer stats (visits, spend, first/last visit)', async () => {
    await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w));
    const c = await cust(w);
    expect(c!.stats).toMatchObject({ visits: 1, spendPaise: 118000, lastVisit: getBusinessDate(), firstVisit: getBusinessDate() });
  });

  it('updates the daily summary with sales and collections by mode', async () => {
    await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w, {
      payments: [{ mode: 'cash', amountPaise: 18000 }, { mode: 'upi', amountPaise: 100000 }],
    }));
    const s: any = await DailySummary.findById(`${w.branchA._id}:${getBusinessDate()}`).lean();
    expect(s.sales.netPaise).toBe(100000);
    expect(s.sales.taxPaise).toBe(18000);
    expect(s.collections).toMatchObject({ cash: 18000, upi: 100000 });
    expect(s.counts.bills).toBe(1);
  });

  it('earns loyalty points when loyalty is enabled (1 point per ₹100)', async () => {
    await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w));
    const c = await cust(w);
    expect(c!.loyaltyPoints).toBe(11); // ₹1,180 -> 11 points
  });

  it('wallet payment debits the wallet and writes a ledger row', async () => {
    await Customer.updateOne({ _id: w.customer._id, businessId: w.business._id }, { $set: { walletBalancePaise: 50000 } });
    const res = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w, {
      payments: [{ mode: 'wallet', amountPaise: 50000 }, { mode: 'cash', amountPaise: 68000 }],
    }));
    expect(res.body.status).toBe('paid');
    expect((await cust(w))!.walletBalancePaise).toBe(0);
  });

  it('wallet payment above balance -> 422 INSUFFICIENT_WALLET and nothing is written', async () => {
    await Customer.updateOne({ _id: w.customer._id, businessId: w.business._id }, { $set: { walletBalancePaise: 1000 } });
    const res = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w, { payments: [{ mode: 'wallet', amountPaise: 118000 }] }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_WALLET');
    expect(await Bill.countDocuments({ businessId: w.business._id })).toBe(0);
    expect(await Counter.countDocuments({ _id: new RegExp(`^${w.business._id}:${w.branchA._id}:invoice`) })).toBe(0);
  });
});

describe('Billing — discounts and approvals', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('branch discount within limit (10%) -> paid', async () => {
    const res = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w, {
      billDiscount: { type: 'pct', value: 1000 }, payments: [{ mode: 'cash', amountPaise: 106200 }],
    }));
    expect(res.body.status).toBe('paid');
  });

  it('branch discount above limit -> awaiting_approval, and NO effects applied yet', async () => {
    const res = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [{ kind: 'product', refId: w.retail._id.toString(), qty: 1 }],
      payments: [{ mode: 'cash', amountPaise: 1 }],
    });
    // owner with due -> partly_paid (owner never needs approval)
    expect(res.body.status).toBe('partly_paid');

    const r2 = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), billedByStaffId: w.receptionist._id.toString(),
      lines: [{ kind: 'product', refId: w.retail._id.toString(), qty: 1 }],
      billDiscount: { type: 'pct', value: 1500 }, payments: [{ mode: 'cash', amountPaise: 50200 }],
    });
    expect(r2.body.status).toBe('awaiting_approval');
    expect(r2.body.approval.reasons).toContain('discount_over_limit');
    expect(await stock(w, w.retail._id, 'retail')).toBe(9); // only owner's bill deducted
  });

  it('amount discount is converted to % for the limit check', async () => {
    const res = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w, {
      billDiscount: { type: 'amount', value: 20000 }, payments: [{ mode: 'cash', amountPaise: 94400 }],
    }));
    expect(res.body.status).toBe('awaiting_approval');
  });

  it('manager limit is 20%: 25% needs approval', async () => {
    const res = await as(w.tokens.manager).post(`/branches/${w.branchA._id}/bills`, branchBill(w, {
      billDiscount: { type: 'pct', value: 2500 }, payments: [{ mode: 'cash', amountPaise: 88500 }],
    }));
    expect(res.body.status).toBe('awaiting_approval');
  });

  it('per-manager maxDiscountBps override (5%) is enforced', async () => {
    await User.updateOne({ _id: w.manager._id, businessId: w.business._id }, { $set: { 'flags.maxDiscountBps': 500 } });
    const res = await as(w.tokens.manager).post(`/branches/${w.branchA._id}/bills`, branchBill(w, {
      billDiscount: { type: 'pct', value: 1000 }, payments: [{ mode: 'cash', amountPaise: 106200 }],
    }));
    expect(res.body.status).toBe('awaiting_approval');
  });

  it('owner discount is unlimited', async () => {
    const res = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, branchBill(w, {
      billDiscount: { type: 'pct', value: 9000 }, payments: [{ mode: 'cash', amountPaise: 11800 }],
    }));
    expect(res.body.status).toBe('paid');
  });

  it('awaiting bills show in /approvals for the manager; approve applies effects', async () => {
    const r = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), billedByStaffId: w.receptionist._id.toString(),
      lines: [{ kind: 'product', refId: w.retail._id.toString(), qty: 1 }],
      billDiscount: { type: 'pct', value: 1500 }, payments: [{ mode: 'cash', amountPaise: 50200 }],
    });
    const list = await as(w.tokens.manager).get('/approvals');
    expect(list.body.map((b: any) => b._id)).toContain(r.body._id);

    const ok = await as(w.tokens.manager).post(`/bills/${r.body._id}/decide`, { decision: 'approve' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('paid');
    expect(await stock(w, w.retail._id, 'retail')).toBe(9);
  });

  it('a manager cannot approve a bill of a branch they do not manage', async () => {
    const r = await as(w.tokens.branchB).post(`/branches/${w.branchB._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylistB._id)],
      billDiscount: { type: 'pct', value: 5000 }, payments: [{ mode: 'cash', amountPaise: 59000 }],
      billedByStaffId: (await createStaff(w.business._id, w.branchB._id, { designation: 'receptionist' }))._id.toString(),
    });
    expect(r.body.status).toBe('awaiting_approval');
    const res = await as(w.tokens.manager).post(`/bills/${r.body._id}/decide`, { decision: 'approve' });
    expect([403, 404]).toContain(res.status);
  });

  it('reject keeps the invoice number used, writes no effects', async () => {
    const r = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), billedByStaffId: w.receptionist._id.toString(),
      lines: [{ kind: 'product', refId: w.retail._id.toString(), qty: 1 }],
      billDiscount: { type: 'pct', value: 1500 }, payments: [{ mode: 'cash', amountPaise: 50200 }],
    });
    const rej = await as(w.tokens.manager).post(`/bills/${r.body._id}/decide`, { decision: 'reject', reason: 'Too much' });
    expect(rej.body.status).toBe('rejected');
    expect(rej.body.invoiceNo).toBe(r.body.invoiceNo);
    expect(await stock(w, w.retail._id, 'retail')).toBe(10);
  });

  it('an unrecognised decision value must not silently reject the bill', async () => {
    const r = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w, {
      billDiscount: { type: 'pct', value: 1500 }, payments: [{ mode: 'cash', amountPaise: 100300 }],
    }));
    const res = await as(w.tokens.manager).post(`/bills/${r.body._id}/decide`, { decision: 'aprove' });
    expect(res.status).toBe(400);
  });

  it('approving twice -> 422 INVALID_TRANSITION', async () => {
    const r = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w, {
      billDiscount: { type: 'pct', value: 1500 }, payments: [{ mode: 'cash', amountPaise: 100300 }],
    }));
    await as(w.tokens.manager).post(`/bills/${r.body._id}/decide`, { decision: 'approve' });
    const again = await as(w.tokens.manager).post(`/bills/${r.body._id}/decide`, { decision: 'approve' });
    expect(again.status).toBe(422);
  });

  it('preview computes totals and approval need without writing anything', async () => {
    const res = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills/preview`, branchBill(w, { billDiscount: { type: 'pct', value: 1500 } }));
    expect(res.status).toBe(200);
    expect(res.body.totals.taxablePaise).toBe(85000);
    expect(res.body.needsApproval).toBe(true);
    expect(await Bill.countDocuments({ businessId: w.business._id })).toBe(0);
    expect(await Counter.countDocuments({})).toBe(0);
  });

  it('preview cannot be used to price another tenant\'s service', async () => {
    const res = await as(w.tokens.otherOwner).post(`/branches/${w.otherBranch._id}/bills/preview`, {
      lines: [serviceLine(w.haircut._id)],
    });
    expect(res.status).toBe(404);
  });
});

describe('Billing — dues (BR-03)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('owner partial payment -> partly_paid with an open due on the customer', async () => {
    const res = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, branchBill(w, { payments: [{ mode: 'cash', amountPaise: 100000 }] }));
    expect(res.body.status).toBe('partly_paid');
    expect(res.body.totals.duePaise).toBe(18000);
    const due = await Due.findOne({ businessId: w.business._id, billId: res.body._id });
    expect(due).toMatchObject({ amountPaise: 18000, status: 'open' });
    expect((await cust(w))!.duePaise).toBe(18000);
  });

  it('branch partial payment needs approval; approval creates the due', async () => {
    const r = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, branchBill(w, { payments: [{ mode: 'cash', amountPaise: 100000 }] }));
    expect(r.body.status).toBe('awaiting_approval');
    expect(r.body.approval.reasons).toContain('partly_paid');
    const ok = await as(w.tokens.manager).post(`/bills/${r.body._id}/decide`, { decision: 'approve' });
    expect(ok.body.status).toBe('partly_paid');
    expect((await cust(w))!.duePaise).toBe(18000);
  });

  it('due receipt settles oldest dues first and issues a receipt number', async () => {
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, branchBill(w, { payments: [{ mode: 'cash', amountPaise: 100000 }] }));
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, branchBill(w, { payments: [{ mode: 'cash', amountPaise: 108000 }] }));
    const rc = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/due-receipts`, {
      customerId: w.customer._id.toString(), payments: [{ mode: 'upi', amountPaise: 20000 }],
    });
    expect(rc.status).toBe(201);
    expect(rc.body.receiptNo).toMatch(/RCP-000001$/);
    const dues = await Due.find({ businessId: w.business._id }).sort({ createdAt: 1 });
    expect(dues[0].status).toBe('settled');
    expect(dues[1].settledPaise).toBe(2000);
    expect((await cust(w))!.duePaise).toBe(8000);
  });

  it('EDGE: due receipt larger than total dues is rejected (no unallocated money)', async () => {
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, branchBill(w, { payments: [{ mode: 'cash', amountPaise: 100000 }] }));
    const rc = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/due-receipts`, {
      customerId: w.customer._id.toString(), payments: [{ mode: 'cash', amountPaise: 99999900 }],
    });
    expect([400, 422]).toContain(rc.status);
  });

  it('EDGE: collecting an old due inside a new bill requires the money to be paid', async () => {
    const first = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, branchBill(w, { payments: [{ mode: 'cash', amountPaise: 100000 }] }));
    const due = await Due.findOne({ businessId: w.business._id, billId: first.body._id });
    // New bill pays only its own ₹1,180 but claims to also collect the ₹180 due
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, branchBill(w, {
      collectDues: [{ dueId: due!._id.toString(), amountPaise: 18000 }],
    }));
    const after = await Due.findOne({ _id: due!._id, businessId: w.business._id });
    expect(after!.status).toBe('open');
  });

  it('GET /customers/:id/dues lists open dues', async () => {
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, branchBill(w, { payments: [{ mode: 'cash', amountPaise: 100000 }] }));
    const res = await as(w.tokens.branchA).get(`/customers/${w.customer._id}/dues`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});
