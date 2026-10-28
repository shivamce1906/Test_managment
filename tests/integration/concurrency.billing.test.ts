import '../helpers/testEnv';
import mongoose, { Types } from 'mongoose';
import { useTestDb, syncAllIndexes } from '../helpers/db';
import { seedWorld, World, serviceLine, dayOffset, as } from '../helpers/factory';
import { billingService } from '../../src/services';
import { Bill, Customer, CustomerPlan, User, EmailRegistry } from '../../src/models';

const ownerCtx = (w: World): any => ({
  userId: w.owner._id.toString(), businessId: w.business._id.toString(), role: 'owner', kind: 'tenant', name: 'Owner', branchIds: [],
});

describe('Concurrency — billing (Backend SRS §12 concurrency gate)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('50 parallel bill saves on one branch -> 50 unique, gap-free invoice numbers', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        billingService.createBill(ownerCtx(w), w.branchA._id.toString(), {
          customerId: w.customer._id.toString(),
          lines: [serviceLine(w.haircut._id, w.stylist1._id)],
          payments: [{ mode: 'cash', amountPaise: 118000 }],
        })
      )
    );
    const ok = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    expect(ok).toHaveLength(50);
    const seqs = ok.map((r) => Number(r.value.invoiceNo.split('/')[2])).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(50);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  }, 60000);

  it('customer stats stay correct under 20 parallel bills (no lost updates)', async () => {
    await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        billingService.createBill(ownerCtx(w), w.branchA._id.toString(), {
          customerId: w.customer._id.toString(),
          lines: [serviceLine(w.haircut._id, w.stylist1._id)],
          payments: [{ mode: 'cash', amountPaise: 118000 }],
        })
      )
    );
    const saved = await Bill.countDocuments({ businessId: w.business._id, status: 'paid' });
    const c = await Customer.findOne({ _id: w.customer._id, businessId: w.business._id });
    expect(c!.stats.visits).toBe(saved);
    expect(c!.stats.spendPaise).toBe(saved * 118000);
  }, 60000);

  it('two simultaneous bills each spending the full wallet: exactly one succeeds, wallet never negative, no orphan bill', async () => {
    await Customer.updateOne({ _id: w.customer._id, businessId: w.business._id }, { $set: { walletBalancePaise: 118000 } });
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        billingService.createBill(ownerCtx(w), w.branchA._id.toString(), {
          customerId: w.customer._id.toString(),
          lines: [serviceLine(w.haircut._id, w.stylist1._id)],
          payments: [{ mode: 'wallet', amountPaise: 118000 }],
        })
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const c = await Customer.findOne({ _id: w.customer._id, businessId: w.business._id });
    expect(c!.walletBalancePaise).toBe(0);
    expect(await Bill.countDocuments({ businessId: w.business._id })).toBe(1);
  }, 60000);

  it('last package session redeemed twice at the same time: only one redemption succeeds', async () => {
    const cp = await CustomerPlan.create({
      businessId: w.business._id, customerId: w.customer._id, planId: new Types.ObjectId(),
      planSnap: { type: 'package' }, soldBillId: new Types.ObjectId(), soldBranchId: w.branchA._id,
      validFrom: dayOffset(-1), validTill: dayOffset(30),
      sessions: [{ serviceId: w.haircut._id, total: 1, used: 0, perSessionValuePaise: 80000 }],
      status: 'active', log: [{ action: 'redeem', at: new Date(), by: w.owner._id }],
    });
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        billingService.createBill(ownerCtx(w), w.branchA._id.toString(), {
          customerId: w.customer._id.toString(),
          lines: [serviceLine(w.haircut._id, w.stylist1._id)],
          redemptions: [{ kind: 'package', refId: cp._id.toString(), lineId: '0' }],
          payments: [],
        })
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const after = await CustomerPlan.findOne({ _id: cp._id, businessId: w.business._id });
    expect(after!.sessions![0].used).toBe(1);
  }, 60000);

  it('same Idempotency-Key fired twice in parallel creates one bill', async () => {
    const send = () => as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 118000 }],
    }).set('Idempotency-Key', 'double-tap');
    await Promise.all([send(), send()]);
    expect(await Bill.countDocuments({ businessId: w.business._id })).toBe(1);
  }, 60000);
});

describe('Database integrity — unique indexes (Database Design §13 index list)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  const hasUniqueIndex = async (collection: string, keys: Record<string, number>) => {
    const idx = await mongoose.connection.db!.collection(collection).indexes().catch(() => []);
    return idx.some((i: any) => i.unique && JSON.stringify(i.key) === JSON.stringify(keys));
  };

  it('the app builds its unique indexes on startup (bills: businessId+invoiceNo)', async () => {
    expect(await hasUniqueIndex('bills', { businessId: 1, invoiceNo: 1 })).toBe(true);
  });

  it('the app builds its unique indexes on startup (customers: businessId+phone)', async () => {
    expect(await hasUniqueIndex('customers', { businessId: 1, phone: 1 })).toBe(true);
  });

  it('DB rejects a second customer with the same phone in the same business', async () => {
    await expect(
      Customer.create({ businessId: w.business._id, name: 'Dup', phone: w.customer.phone, source: 'walk_in' })
    ).rejects.toThrow(/duplicate key/i);
  });

  it('DB rejects a duplicate invoice number in the same business', async () => {
    const b = await billingService.createBill(ownerCtx(w), w.branchA._id.toString(), {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 118000 }],
    });
    const copy: any = (await Bill.findOne({ _id: b._id, businessId: w.business._id }))!.toObject();
    delete copy._id;
    copy.idempotencyKey = 'other';
    await expect(Bill.create(copy)).rejects.toThrow(/duplicate key/i);
  });

  it('DB rejects a second owner for the same business', async () => {
    await expect(
      User.create({ businessId: w.business._id, role: 'owner', name: 'Owner 2', email: 'o2@x.test', passwordHash: 'x' })
    ).rejects.toThrow(/duplicate key/i);
  });

  it('parallel customer creation with the same phone yields exactly one customer', async () => {
    await Promise.allSettled(
      [1, 2, 3].map(() => as(w.tokens.owner).post('/customers', { name: 'Same', phone: '9822222222' }))
    );
    expect(await Customer.countDocuments({ businessId: w.business._id, phone: '+919822222222' })).toBe(1);
  });

  it('CONTROL: once indexes are synced, duplicates ARE rejected (shows the fix)', async () => {
    await syncAllIndexes();
    await expect(
      Customer.create({ businessId: w.business._id, name: 'Dup', phone: w.customer.phone, source: 'walk_in' })
    ).rejects.toThrow(/duplicate key/i);
    await expect(EmailRegistry.create({ _id: w.owner.email, kind: 'tenant', userId: w.owner._id })).rejects.toThrow(/duplicate key/i);
  });
});
