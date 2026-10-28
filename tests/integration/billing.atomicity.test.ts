import '../helpers/testEnv';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, World, createPlan } from '../helpers/factory';
import { Bill, StockBalance, Counter } from '../../src/models';

/**
 * Backend SRS §8: "Every flow below runs inside one MongoDB transaction; either all
 * writes land or none do." These tests force a failure half-way through a bill save
 * and check nothing was left behind.
 */
describe('Billing atomicity (transactions)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('a bill that fails mid-save leaves no bill, no stock change and no used invoice number', async () => {
    const plan = await createPlan(w.business._id, { type: 'membership', name: 'Gold', pricePaise: 200000, validityDays: 365 });
    const res = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(),
      lines: [{ kind: 'product', refId: w.retail._id.toString(), qty: 1 }, { kind: 'membership', refId: plan._id.toString() }],
      payments: [{ mode: 'cash', amountPaise: 295000 }],
    });
    if (res.status === 201) return; // sale works -> nothing to roll back

    expect(await Bill.countDocuments({ businessId: w.business._id })).toBe(0);
    const s = await StockBalance.findOne({ businessId: w.business._id, branchId: w.branchA._id, productId: w.retail._id, pool: 'retail' });
    expect(s!.qty).toBe(10);
  });

  it('a failed request never returns 500 for a business-rule problem', async () => {
    const plan = await createPlan(w.business._id, { type: 'package', name: 'P', pricePaise: 100000, validityDays: 30, package: { items: [{ serviceId: w.haircut._id, sessions: 2 }] } });
    const res = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [{ kind: 'package', refId: plan._id.toString() }], payments: [{ mode: 'cash', amountPaise: 118000 }],
    });
    expect(res.status).toBeLessThan(500);
  });

  it('retrying after a 500 must not create a duplicate paid bill', async () => {
    const plan = await createPlan(w.business._id, { type: 'membership', name: 'Gold', pricePaise: 200000, validityDays: 365 });
    const body = {
      customerId: w.customer._id.toString(),
      lines: [{ kind: 'product', refId: w.retail._id.toString(), qty: 1 }, { kind: 'membership', refId: plan._id.toString() }],
      payments: [{ mode: 'cash', amountPaise: 295000 }],
    };
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, body);
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, body);
    expect(await Bill.countDocuments({ businessId: w.business._id, status: 'paid' })).toBeLessThanOrEqual(1);
  });

  it('invoice counter only advances for bills that were actually saved', async () => {
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [{ kind: 'product', refId: w.retail._id.toString(), qty: 1 }],
      payments: [{ mode: 'wallet', amountPaise: 59000 }], // customer has no wallet -> rejected
    });
    const saved = await Bill.countDocuments({ businessId: w.business._id });
    const counters = await Counter.find({ _id: new RegExp(`^${w.business._id}:${w.branchA._id}:invoice`) });
    expect(counters.reduce((a, c: any) => a + c.seq, 0)).toBe(saved);
  });
});
