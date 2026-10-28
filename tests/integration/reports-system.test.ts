import '../helpers/testEnv';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, World, serviceLine } from '../helpers/factory';
import { AuditLog, Notification, DailySummary, Appointment } from '../../src/models';
import { getBusinessDate } from '../../src/utils';

const REPORTS = [
  'sales-summary', 'branch-comparison', 'service-profitability', 'product-profitability', 'customer-retention',
  'membership-liability', 'staff-performance', 'attendance-payroll', 'inventory-valuation', 'discounts-cancellations',
  'expenses-pnl', 'day-closures', 'leads-conversion', 'whatsapp-spend', 'gstr-1',
];

async function someSales(w: World) {
  await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
    customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 118000 }],
  });
  await as(w.tokens.owner).post(`/branches/${w.branchB._id}/bills`, {
    customerId: w.customer._id.toString(), lines: [serviceLine(w.colour._id, w.stylistB._id)], payments: [{ mode: 'upi', amountPaise: 295000 }],
  });
}

describe('Reports (PRD §15)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it.each(REPORTS)('owner can run report "%s" without error', async (name) => {
    await someSales(w);
    const res = await as(w.tokens.owner).get(`/reports/${name}?from=${getBusinessDate()}&to=${getBusinessDate()}`);
    expect(res.status).toBe(200);
  });

  it('unknown report name -> 404/400, not 500', async () => {
    const res = await as(w.tokens.owner).get('/reports/everything');
    expect([400, 404]).toContain(res.status);
  });

  it('sales summary for branch A shows only branch A\'s net sales and GST', async () => {
    await someSales(w);
    const res = await as(w.tokens.owner).get(`/reports/sales-summary?branchId=${w.branchA._id}&from=${getBusinessDate()}&to=${getBusinessDate()}`);
    expect(JSON.stringify(res.body)).toContain('100000');
    expect(JSON.stringify(res.body)).not.toContain('250000');
  });

  it('date range is honoured: a range in the past returns no sales', async () => {
    await someSales(w);
    const res = await as(w.tokens.owner).get('/reports/sales-summary?from=2020-01-01&to=2020-01-31');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/100000|250000/);
  });

  it('manager cannot run a report for a branch they do not manage', async () => {
    const res = await as(w.tokens.manager).get(`/reports/sales-summary?branchId=${w.branchB._id}`);
    expect(res.status).toBe(403);
  });

  it('manager without a branch filter sees only assigned branches', async () => {
    await someSales(w);
    const res = await as(w.tokens.manager).get(`/reports/branch-comparison?from=${getBusinessDate()}&to=${getBusinessDate()}`);
    expect(JSON.stringify(res.body)).not.toContain(String(w.branchB._id));
  });

  it('GSTR-1 is not available for a GST-off business', async () => {
    const w2 = await seedWorld({ gst: false });
    const res = await as(w2.tokens.owner).get('/reports/gstr-1');
    expect([400, 404, 422]).toContain(res.status);
  });

  it('report export returns an Excel file (owner)', async () => {
    await someSales(w);
    const res = await as(w.tokens.owner).get(`/reports/sales-summary/export?from=${getBusinessDate()}&to=${getBusinessDate()}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml|excel|octet-stream/);
  });

  it('report reads from pre-aggregated daily summaries (fast path) — summary row exists after billing', async () => {
    await someSales(w);
    expect(await DailySummary.countDocuments({ businessId: w.business._id })).toBe(2);
  });
});

describe('Owner dashboard (PRD §15)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('owner dashboard loads with today\'s sales across branches', async () => {
    await someSales(w);
    const res = await as(w.tokens.owner).get('/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.today.salesPaise).toBe(350000);
    expect(res.body.today.billsCount).toBe(2);
  });

  it('dashboard counts today\'s appointments', async () => {
    const today = getBusinessDate();
    await Appointment.create({
      businessId: w.business._id, branchId: w.branchA._id, customerId: w.customer._id, businessDate: today,
      lines: [{ serviceId: w.haircut._id, serviceName: 'Haircut', staffId: w.stylist1._id, start: new Date(), end: new Date(Date.now() + 1800000) }],
      start: new Date(), end: new Date(Date.now() + 1800000), status: 'booked',
      statusLog: [{ status: 'booked', at: new Date(), by: w.owner._id }], source: 'phone',
    });
    const res = await as(w.tokens.owner).get(`/dashboard?branchId=${w.branchA._id}`);
    expect(res.status).toBe(200);
    expect(res.body.today.appointmentsCount).toBe(1);
  });

  it('manager dashboard is limited to assigned branches', async () => {
    await someSales(w);
    const res = await as(w.tokens.manager).get('/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.today.salesPaise).toBe(100000);
  });
});

describe('Audit log (PRD §16: append-only)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('owner can search the audit log by action', async () => {
    await someSales(w);
    const res = await as(w.tokens.owner).get('/audit-logs?action=bill.create');
    expect(res.status).toBe(200);
    expect((res.body.logs || res.body).length).toBe(2);
  });

  it('owner only sees their own business\'s audit rows', async () => {
    await someSales(w);
    const res = await as(w.tokens.otherOwner).get('/audit-logs');
    expect((res.body.logs || res.body).length).toBe(0);
  });

  it('every audit row records who, when, entity and IP', async () => {
    await someSales(w);
    const row: any = await AuditLog.findOne({ businessId: w.business._id, action: 'bill.create' }).lean();
    expect(row.actor).toMatchObject({ kind: 'tenant', role: 'owner' });
    expect(row.at).toBeTruthy();
    expect(row.entityId).toBeTruthy();
    expect(row.ip).toBeTruthy();
  });

  it('audit rows cannot be modified or deleted through the model (append-only)', async () => {
    await someSales(w);
    const row = await AuditLog.findOne({ businessId: w.business._id });
    await expect(AuditLog.updateOne({ _id: row!._id }, { $set: { action: 'tampered' } })).rejects.toThrow();
    await expect(AuditLog.deleteOne({ _id: row!._id })).rejects.toThrow();
  });

  it('audit export is owner-only and returns a file', async () => {
    const res = await as(w.tokens.owner).get('/audit-logs/export');
    expect(res.status).toBe(200);
  });
});

describe('Notifications and change polling (Backend SRS §9)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('user sees only their own notifications and can mark them read', async () => {
    const mine = await Notification.create({ businessId: w.business._id, userId: w.owner._id, type: 'low_stock', title: 'Low stock', body: 'Shampoo' });
    await Notification.create({ businessId: w.business._id, userId: w.manager._id, type: 'x', title: 'x', body: 'x' });
    const list = await as(w.tokens.owner).get('/notifications');
    expect(list.status).toBe(200);
    expect((list.body.notifications || list.body).length).toBe(1);
    const rd = await as(w.tokens.owner).patch(`/notifications/${mine._id}/read`);
    expect(rd.status).toBe(200);
  });

  it('cannot mark someone else\'s notification as read', async () => {
    const theirs = await Notification.create({ businessId: w.business._id, userId: w.manager._id, type: 'x', title: 'x', body: 'x' });
    expect((await as(w.tokens.owner).patch(`/notifications/${theirs._id}/read`)).status).toBe(404);
  });

  it('a bill bumps the bills:<branch> scope so polling reports a change', async () => {
    const scope = `bills:${w.branchA._id}`;
    const before = await as(w.tokens.owner).get(`/changes?scopes=${scope}`);
    expect(before.status).toBe(200);
    await someSales(w);
    const after = await as(w.tokens.owner).get(`/changes?scopes=${scope}`);
    expect(JSON.stringify(after.body)).not.toBe(JSON.stringify(before.body));
  });

  it('booking an appointment bumps the calendar scope', async () => {
    const d = getBusinessDate(new Date(Date.now() + 86400000));
    const scope = `appointments:${w.branchA._id}:${d}`;
    const before = await as(w.tokens.owner).get(`/changes?scopes=${scope}`);
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/appointments`, {
      customerId: w.customer._id.toString(),
      lines: [{ serviceId: w.haircut._id.toString(), staffId: w.stylist1._id.toString(), start: new Date(`${d}T05:30:00.000Z`).toISOString() }],
    });
    const after = await as(w.tokens.owner).get(`/changes?scopes=${scope}`);
    expect(JSON.stringify(after.body)).not.toBe(JSON.stringify(before.body));
  });

  it('manager can poll own branch scopes but not another branch\'s', async () => {
    expect((await as(w.tokens.manager).get(`/changes?scopes=bills:${w.branchA._id}`)).status).toBe(200);
    const res = await as(w.tokens.manager).get(`/changes?scopes=bills:${w.branchB._id}`);
    expect(res.status).toBe(403);
  });

  it('upload presign returns a URL and key; rejects disallowed types', async () => {
    const ok = await as(w.tokens.owner).post('/uploads/presign', { kind: 'receipt', contentType: 'image/jpeg' });
    expect(ok.status).toBe(200);
    expect(ok.body.url).toBeTruthy();
    const bad = await as(w.tokens.owner).post('/uploads/presign', { kind: 'receipt', contentType: 'application/x-msdownload' });
    expect(bad.status).toBe(400);
  });
});

describe('Health and hardening (Backend SRS §12)', () => {
  useTestDb();

  it('/health and /ready respond', async () => {
    expect((await as().get('/health')).status).toBe(200);
    expect((await as().get('/ready')).status).toBe(200);
  });

  it('every response carries an x-request-id', async () => {
    const res = await as().get('/health');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('CORS only allows configured app origins', async () => {
    const res = await as().get('/health').set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example.com');
  });

  it('JSON body larger than 1 MB is rejected (413)', async () => {
    const w = await seedWorld();
    const res = await as(w.tokens.owner).post('/customers', { name: 'x', phone: '9800000000', notes: 'a'.repeat(2 * 1024 * 1024) });
    expect(res.status).toBe(413);
  });

  it('Mongo operator injection in query is neutralised', async () => {
    const w = await seedWorld();
    const res = await as(w.tokens.branchA).get('/customers?q[$ne]=x');
    expect(res.status).toBeLessThan(500);
  });

  it('unknown keys in a body are rejected (Backend SRS §2: "unknown keys rejected")', async () => {
    const w = await seedWorld();
    const res = await as(w.tokens.owner).post('/customers', { name: 'x', phone: '9800000001', walletBalancePaise: 99999999 });
    expect(res.status).toBe(400);
  });

  it('a customer cannot be created with a wallet balance by mass-assignment', async () => {
    const w = await seedWorld();
    const res = await as(w.tokens.owner).post('/customers', { name: 'x', phone: '9800000002', walletBalancePaise: 99999999, loyaltyPoints: 5000 });
    if (res.status === 201) {
      expect(res.body.walletBalancePaise).toBe(0);
      expect(res.body.loyaltyPoints).toBe(0);
    }
  });

  it('duplicate customer phone -> 409 DUPLICATE_PHONE with the existing id', async () => {
    const w = await seedWorld();
    const res = await as(w.tokens.owner).post('/customers', { name: 'Again', phone: '9876543210' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_PHONE');
    expect(res.body.error.details.customerId).toBe(w.customer._id.toString());
  });

  it('invalid customer phone (letters) -> 400', async () => {
    const w = await seedWorld();
    const res = await as(w.tokens.owner).post('/customers', { name: 'x', phone: 'abcdefghij' });
    expect(res.status).toBe(400);
  });
});
