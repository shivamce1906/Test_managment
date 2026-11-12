import '../helpers/testEnv';

// The in-memory test Redis cannot run BullMQ's scripts: capture queued jobs instead
const queued: { queue: string; data: any; opts: any }[] = [];
jest.mock('bullmq', () => ({
  Worker: class { on() { return this; } close() { return Promise.resolve(); } },
  Queue: class {
    constructor(public name: string) {}
    add(_n: string, data: any, opts: any) { queued.push({ queue: this.name, data, opts }); return Promise.resolve({ id: 'x' }); }
    upsertJobScheduler() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  },
  QueueEvents: class { on() {} },
}));
import ExcelJS from 'exceljs';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, World, serviceLine, createPlatformAdmin, platformToken } from '../helpers/factory';
import { Automation, Bill, Branch, Customer, WaMessage, WaNumber, WaTemplate, WaConversation } from '../../src/models';
import { encryptData, getBusinessDate } from '../../src/utils';

const today = getBusinessDate();
const q = `from=${today}&to=${today}`;
const haircutBill = (w: World, extra: any = {}) =>
  as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
    customerId: w.customer._id.toString(),
    lines: [serviceLine(w.haircut._id, w.stylist1._id)],
    payments: [{ mode: 'upi', amountPaise: 118000 }],
    ...extra,
  });

/** Downloads a binary response (xlsx / pdf) as a Buffer. */
const binary = (req: any) =>
  req.buffer(true).parse((res: any, cb: any) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

describe('I-01 reports: database totals, billed-by, PDF, GSTR-1 offline tool', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('sales-summary totals equal the bills, refund counted on its day', async () => {
    const b1 = await haircutBill(w);
    await haircutBill(w);
    await as(w.tokens.owner).post(`/bills/${b1.body._id}/refund`, { amountPaise: 5000, mode: 'cash', reason: 'x' });
    const r = await as(w.tokens.owner).get(`/reports/sales-summary?${q}`);
    expect(r.status).toBe(200);
    const bills = await Bill.find({ businessId: w.business._id, businessDate: today }).lean();
    expect(r.body.summary.bills).toBe(2);
    expect(r.body.summary.netPaise).toBe(bills.reduce((a, b) => a + b.totals.taxablePaise, 0));
    expect(r.body.summary.totalPaise).toBe(bills.reduce((a, b) => a + b.totals.totalPaise, 0));
    expect(r.body.summary.upiPaise).toBe(236000);
    expect(r.body.summary.refundsPaise).toBe(5000);
    expect(r.body.rows[0]).toMatchObject({ date: today, bills: 2, customers: 1 });
  });

  it('sales-summary can be grouped by the person who raised the bill', async () => {
    await haircutBill(w);
    const r = await as(w.tokens.owner).get(`/reports/sales-summary?${q}&groupBy=billedBy`);
    expect(r.status).toBe(200);
    expect(r.body.groupBy).toBe('billedBy');
    expect(r.body.rows).toHaveLength(1);
    expect(r.body.rows[0]).toHaveProperty('billedBy');
    expect(r.body.rows[0].bills).toBe(1);
  });

  it('branch-comparison lists every branch, zero rows included', async () => {
    await haircutBill(w);
    const r = await as(w.tokens.owner).get(`/reports/branch-comparison?${q}`);
    expect(r.body.rows).toHaveLength(2);
    expect(r.body.rows[0]).toMatchObject({ branchId: String(w.branchA._id), bills: 1 });
    expect(r.body.rows[1]).toMatchObject({ bills: 0, netPaise: 0 });
  });

  it('reports export as PDF', async () => {
    await haircutBill(w);
    const r = await binary(as(w.tokens.owner).get(`/reports/sales-summary/export?${q}&format=pdf`));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect((r.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('GSTR-1 export uses the GST offline-tool sheets and column names', async () => {
    await haircutBill(w);
    const r = await binary(as(w.tokens.owner).get(`/reports/gstr-1/export?${q}`));
    expect(r.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body);
    expect(wb.worksheets.map((s) => s.name)).toEqual(['b2b', 'b2cs', 'hsn', 'docs']);
    const header = (name: string) => (wb.getWorksheet(name)!.getRow(1).values as any[]).slice(1);
    expect(header('b2cs')).toEqual(['Type', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN']);
    expect(header('hsn')).toContain('Central Tax Amount');
    const b2cs = wb.getWorksheet('b2cs')!.getRow(2).values as any[];
    expect(b2cs[1]).toBe('OE');
    expect(String(b2cs[2])).toMatch(/^24-/); // Gujarat
    expect(b2cs[5]).toBe(1000); // taxable value in rupees
    const docs = wb.getWorksheet('docs')!.getRow(2).values as any[];
    expect(docs[1]).toBe('Invoices for outward supply');
    expect(docs[4]).toBe(1);
  });
});

describe('I-04 customer stats under parallel bills', () => {
  useTestDb();
  it('8 bills for one customer at the same moment all succeed and all count', async () => {
    const w = await seedWorld();
    const results = await Promise.all(Array.from({ length: 8 }, () => haircutBill(w)));
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
    const c = await Customer.findOne({ _id: w.customer._id, businessId: w.business._id }).lean();
    expect(c!.stats.visits).toBe(8);
    expect(c!.stats.spendPaise).toBe(8 * 118000);
  });

  it('two parallel bills each paying the whole wallet: exactly one succeeds', async () => {
    const w = await seedWorld();
    await Customer.updateOne({ _id: w.customer._id, businessId: w.business._id }, { $set: { walletBalancePaise: 118000 } });
    const pay = () => haircutBill(w, { payments: [{ mode: 'wallet', amountPaise: 118000 }] });
    const [a, b] = await Promise.all([pay(), pay()]);
    expect([a.status, b.status].filter((s) => s === 201)).toHaveLength(1);
    const c = await Customer.findOne({ _id: w.customer._id, businessId: w.business._id }).lean();
    expect(c!.walletBalancePaise).toBe(0);
  });
});

describe('I-13 status cache: suspension still blocks at once', () => {
  useTestDb();
  it('a cached "active" status is cleared when the Super Admin suspends the business', async () => {
    const w = await seedWorld();
    const sa = platformToken(await createPlatformAdmin());
    expect((await as(w.tokens.owner).get('/customers')).status).toBe(200); // fills the cache
    expect((await as(sa).patch(`/admin/businesses/${w.business._id}`, { status: 'suspended' })).status).toBe(200);
    expect([401, 403]).toContain((await as(w.tokens.owner).get('/customers')).status);
  });
});

describe('I-16 Google review link only when switched on', () => {
  useTestDb();
  let w: World;
  const uid = 'review-uid';
  const secret = 'review-secret-123456';
  beforeEach(async () => {
    w = await seedWorld();
    await Branch.updateOne({ _id: w.branchA._id, businessId: w.business._id }, { $set: { googleReviewUrl: 'https://g.page/r/test' } });
    const number = await WaNumber.create({
      businessId: w.business._id, phone: '+919800000099', provider: 'instant_broadcast',
      instantBroadcast: { uid, userTokenEnc: encryptData('key'), webhookSecretEnc: encryptData(secret) },
      branchIds: [w.branchA._id], status: 'active', lowBalance: false,
    });
    await WaConversation.create({ businessId: w.business._id, numberId: number._id, branchId: w.branchA._id, phone: w.customer.phone, customerId: w.customer._id, unread: 0 });
    await haircutBill(w);
    (w as any).numberId = number._id;
  });
  const rate = (text: string, id: string) =>
    as().post(`/webhooks/instantbroadcast/${uid}?secret=${secret}`, { from: w.customer.phone, text, providerMessageId: id });
  const reviewMessages = () => WaMessage.countDocuments({ businessId: w.business._id, origin: 'automation', text: /google/i });

  it('no review message when the owner never switched review_push on', async () => {
    expect((await rate('5', 'r1')).status).toBe(200);
    expect(await reviewMessages()).toBe(0);
  });

  it('review message is queued when review_push is on', async () => {
    const tpl = await WaTemplate.create({ businessId: w.business._id, numberId: (w as any).numberId, name: 'review', category: 'marketing', body: 'x', status: 'approved' });
    await Automation.create({ businessId: w.business._id, key: 'review_push', enabled: true, templateId: tpl._id });
    expect((await rate('5', 'r2')).status).toBe(200);
    expect(await reviewMessages()).toBe(1);
    const job = queued.find((j) => j.queue === 'whatsapp-send');
    expect(job?.data.businessId).toBe(String(w.business._id));
  });
});

describe('Feedback indexes: one per bill / appointment, not one per business', () => {
  useTestDb();
  it('staff can record feedback for two different bills of the same business', async () => {
    const w = await seedWorld();
    const b1 = await haircutBill(w);
    const b2 = await haircutBill(w);
    const fb = (id: string) =>
      as(w.tokens.owner).post('/whatsapp/feedback', { branchId: String(w.branchA._id), billId: id, customerId: String(w.customer._id), rating: 5 });
    expect((await fb(b1.body._id)).status).toBe(200);
    expect((await fb(b2.body._id)).status).toBe(200);
    // The same bill again updates its feedback instead of adding a second one
    expect((await fb(b1.body._id)).status).toBe(200);
  });
});
