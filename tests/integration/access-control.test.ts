import '../helpers/testEnv';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, World, dayOffset, ist, serviceLine } from '../helpers/factory';
import { billingService } from '../../src/services';
import { AuditLog } from '../../src/models';

const ctxOf = (w: World, user: any, branchId?: any): any => ({
  userId: user._id.toString(),
  businessId: w.business._id.toString(),
  role: user.role,
  kind: 'tenant',
  name: user.name,
  branchIds: (user.branchIds || []).map((b: any) => b.toString()),
  branchId: branchId?.toString(),
  flags: user.flags,
});

async function paidBill(w: World, branch: any, staff: any) {
  return billingService.createBill(ctxOf(w, w.owner), branch._id.toString(), {
    customerId: w.customer._id.toString(),
    lines: [serviceLine(w.haircut._id, staff._id)],
    payments: [{ mode: 'cash', amountPaise: 118000 }],
  });
}

describe('Routing — role middleware must not leak across routers', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('unknown route returns 404, not 401/403', async () => {
    const res = await as(w.tokens.owner).get('/this-route-does-not-exist');
    expect(res.status).toBe(404);
  });

  it('branch login can view its own stock (PRD matrix: Inventory = Branch)', async () => {
    const res = await as(w.tokens.branchA).get(`/branches/${w.branchA._id}/stock`);
    expect(res.status).toBe(200);
  });

  it('branch login can add an expense (PRD matrix: Expenses = Add)', async () => {
    const res = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/expenses`, {
      category: 'tea_snacks', amountPaise: 15000, mode: 'cash', paidFrom: 'till',
    });
    expect(res.status).toBe(201);
  });

  it('branch login can open its day-end closure (PRD matrix: Day-end = Submit)', async () => {
    const res = await as(w.tokens.branchA).get(`/branches/${w.branchA._id}/closures/${dayOffset(0)}`);
    expect(res.status).toBe(200);
  });

  it('branch login can use the WhatsApp inbox (PRD matrix: Full own branch)', async () => {
    const res = await as(w.tokens.branchA).get(`/whatsapp/conversations?branchId=${w.branchA._id}`);
    expect(res.status).toBe(200);
  });

  it('branch login can read its notifications', async () => {
    const res = await as(w.tokens.branchA).get('/notifications');
    expect(res.status).toBe(200);
  });

  it('manager can read notifications and poll /changes', async () => {
    expect((await as(w.tokens.manager).get('/notifications')).status).toBe(200);
    expect((await as(w.tokens.manager).get(`/changes?scopes=bills:${w.branchA._id}`)).status).toBe(200);
  });

  it('manager WITHOUT viewPayroll can still use inventory and reports', async () => {
    const w2 = await seedWorld({ managerFlags: { viewPayroll: false } });
    expect((await as(w2.tokens.manager).get(`/branches/${w2.branchA._id}/stock`)).status).toBe(200);
    expect((await as(w2.tokens.manager).get(`/reports/sales-summary?branchId=${w2.branchA._id}`)).status).not.toBe(403);
  });

  it('public AiSensy webhook is reachable without a bearer token', async () => {
    const res = await as().post('/webhooks/aisensy/000000000000000000000000', { type: 'message' });
    expect(res.status).not.toBe(401);
  });
});

describe('Branch scoping (manager / branch login)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('branch login B cannot read branch A calendar', async () => {
    const res = await as(w.tokens.branchB).get(`/branches/${w.branchA._id}/appointments`);
    expect(res.status).toBe(403);
  });

  it('branch login B cannot create a bill in branch A', async () => {
    const res = await as(w.tokens.branchB).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), billedByStaffId: w.receptionist._id.toString(),
      lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 118000 }],
    });
    expect(res.status).toBe(403);
  });

  it('manager of A cannot access branch B', async () => {
    expect((await as(w.tokens.manager).get(`/branches/${w.branchB._id}/appointments`)).status).toBe(403);
    expect((await as(w.tokens.manager).get(`/branches/${w.branchB._id}/bills`)).status).toBe(403);
  });

  it('branch login A cannot open a bill that belongs to branch B by id', async () => {
    const bill = await paidBill(w, w.branchB, w.stylistB);
    const res = await as(w.tokens.branchA).get(`/bills/${bill._id}`);
    expect([403, 404]).toContain(res.status);
  });

  it('manager of A cannot cancel a bill of branch B', async () => {
    const bill = await paidBill(w, w.branchB, w.stylistB);
    const res = await as(w.tokens.manager).post(`/bills/${bill._id}/cancel`, { reason: 'test' });
    expect([403, 404]).toContain(res.status);
  });

  it('branch login A cannot change the status of a branch B appointment', async () => {
    const d = dayOffset(1);
    const apt = await as(w.tokens.owner).post(`/branches/${w.branchB._id}/appointments`, {
      customerId: w.customer._id.toString(),
      lines: [{ serviceId: w.haircut._id.toString(), staffId: w.stylistB._id.toString(), start: ist(d, '11:00') }],
    });
    expect(apt.status).toBe(201);
    const res = await as(w.tokens.branchA).patch(`/appointments/${apt.body._id}/status`, { status: 'cancelled', reason: 'x' });
    expect([403, 404]).toContain(res.status);
  });

  it('owner cannot use a branch id from another business', async () => {
    const d = dayOffset(1);
    const res = await as(w.tokens.owner).post(`/branches/${w.otherBranch._id}/appointments`, {
      customerId: w.customer._id.toString(),
      lines: [{ serviceId: w.haircut._id.toString(), staffId: w.stylist1._id.toString(), start: ist(d, '11:00') }],
    });
    expect([403, 404]).toContain(res.status);
  });
});

describe('Tenant isolation (Backend SRS §12: other business -> 404)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it.each([
    ['customer', (w: World) => `/customers/${w.customer._id}`],
    ['service', (w: World) => `/services/${w.haircut._id}`],
    ['staff', (w: World) => `/staff/${w.stylist1._id}`],
  ])('other tenant cannot read our %s', async (_n, url) => {
    const res = await as(w.tokens.otherOwner).get(url(w));
    expect(res.status).toBe(404);
  });

  it('other tenant cannot update our customer', async () => {
    const res = await as(w.tokens.otherOwner).patch(`/customers/${w.customer._id}`, { name: 'Hacked' });
    expect(res.status).toBe(404);
  });

  it('other tenant cannot read our bill', async () => {
    const bill = await paidBill(w, w.branchA, w.stylist1);
    expect((await as(w.tokens.otherOwner).get(`/bills/${bill._id}`)).status).toBe(404);
  });

  it('other tenant cannot see our customers in a list', async () => {
    const res = await as(w.tokens.otherOwner).get('/customers');
    expect(res.status).toBe(200);
    const ids = (res.body.customers || res.body).map((c: any) => String(c._id));
    expect(ids).not.toContain(String(w.customer._id));
  });

  it('cannot book an appointment for another business\'s customer', async () => {
    const d = dayOffset(1);
    const res = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/appointments`, {
      customerId: w.otherCustomer._id.toString(),
      lines: [{ serviceId: w.haircut._id.toString(), staffId: w.stylist1._id.toString(), start: ist(d, '11:00') }],
    });
    expect([404, 422]).toContain(res.status);
  });

  it('cannot bill another business\'s customer', async () => {
    const res = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.otherCustomer._id.toString(),
      lines: [serviceLine(w.haircut._id, w.stylist1._id)],
      payments: [{ mode: 'cash', amountPaise: 118000 }],
    });
    expect(res.status).toBe(404);
  });

  it('invalid ObjectId in URL -> 400, not 500', async () => {
    const res = await as(w.tokens.owner).get('/customers/not-an-id');
    expect(res.status).toBe(400);
  });
});

describe('Role permission matrix (PRD §3)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  const svcBody = (w: World) => ({ categoryId: w.category._id.toString(), name: 'Beard', gender: 'men', basePricePaise: 30000, durationMin: 15 });

  it('owner can create a service', async () => {
    expect((await as(w.tokens.owner).post('/services', svcBody(w))).status).toBe(201);
  });
  it('manager can only VIEW services (cannot create)', async () => {
    expect((await as(w.tokens.manager).post('/services', svcBody(w))).status).toBe(403);
  });
  it('branch login cannot create services', async () => {
    expect((await as(w.tokens.branchA).post('/services', svcBody(w))).status).toBe(403);
  });
  it('manager cannot create categories (owner only)', async () => {
    expect((await as(w.tokens.manager).post('/categories', { name: 'Skin', gender: 'unisex' })).status).toBe(403);
  });
  it('manager cannot create products in the business master (write O)', async () => {
    const res = await as(w.tokens.manager).post('/products', {
      name: 'Gel', type: 'retail', purchaseUnit: 'pc', useUnit: 'pc', unitsPerPurchase: 1, purchasePricePaise: 100,
    });
    expect(res.status).toBe(403);
  });
  it('manager cannot create prepaid plans (write O)', async () => {
    const res = await as(w.tokens.manager).post('/plans', { type: 'membership', name: 'Gold', pricePaise: 200000, validityDays: 365 });
    expect(res.status).toBe(403);
  });
  it('branch login cannot cancel, refund or edit bills', async () => {
    const bill = await paidBill(w, w.branchA, w.stylist1);
    expect((await as(w.tokens.branchA).post(`/bills/${bill._id}/cancel`, { reason: 'x' })).status).toBe(403);
    expect((await as(w.tokens.branchA).post(`/bills/${bill._id}/refund`, { amountPaise: 100, mode: 'cash', reason: 'x' })).status).toBe(403);
    expect((await as(w.tokens.branchA).patch(`/bills/${bill._id}`, { reason: 'x' })).status).toBe(403);
  });
  it('only owner can export customers', async () => {
    expect((await as(w.tokens.manager).get('/customers/export')).status).toBe(403);
    expect((await as(w.tokens.branchA).get('/customers/export')).status).toBe(403);
  });
  it('only owner can adjust a wallet', async () => {
    const res = await as(w.tokens.manager).post(`/customers/${w.customer._id}/wallet/adjust`, { amountPaise: 1000, reason: 'x' });
    expect(res.status).toBe(403);
  });
  it('manager can view the audit log for assigned branches', async () => {
    expect((await as(w.tokens.manager).get(`/audit-logs?branchId=${w.branchA._id}`)).status).toBe(200);
  });
  it('branch login cannot view the audit log', async () => {
    expect((await as(w.tokens.branchA).get('/audit-logs')).status).toBe(403);
  });
  it('manager can mark attendance without any extra flag', async () => {
    const res = await as(w.tokens.manager).post(`/staff/branches/${w.branchA._id}/attendance`, {
      entries: [{ staffId: w.stylist1._id.toString(), status: 'present' }],
    });
    expect([200, 201]).toContain(res.status);
  });
  it('branch login cannot mark attendance unless a manager allows it', async () => {
    const res = await as(w.tokens.branchA).post(`/staff/branches/${w.branchA._id}/attendance`, {
      entries: [{ staffId: w.stylist1._id.toString(), status: 'present' }],
    });
    expect(res.status).toBe(403);
  });
  it('branch login WITH markAttendance can mark attendance', async () => {
    const w2 = await seedWorld({ branchLoginFlags: { markAttendance: true } });
    const res = await as(w2.tokens.branchA).post(`/staff/branches/${w2.branchA._id}/attendance`, {
      entries: [{ staffId: w2.stylist1._id.toString(), status: 'present' }],
    });
    expect([200, 201]).toContain(res.status);
  });
  it('manager without manageStaff cannot add staff; with it can', async () => {
    const body = (w: World) => ({
      branchId: w.branchA._id.toString(), name: 'New', phone: '9812345678', designation: 'stylist', joiningDate: '2026-01-01',
      salary: { type: 'monthly', amountPaise: 2000000 },
    });
    const w2 = await seedWorld({ managerFlags: { manageStaff: false } });
    expect((await as(w2.tokens.manager).post('/staff', body(w2))).status).toBe(403);
    expect((await as(w.tokens.manager).post('/staff', body(w))).status).toBe(201);
  });
  it('manager without manageStaff cannot add staff to a branch they do not manage', async () => {
    const res = await as(w.tokens.manager).post('/staff', {
      branchId: w.branchB._id.toString(), name: 'X', phone: '9812345678', designation: 'stylist', joiningDate: '2026-01-01',
      salary: { type: 'monthly', amountPaise: 0 },
    });
    expect([403, 404]).toContain(res.status);
  });
  it('branch login has no payroll access; manager without viewPayroll neither', async () => {
    expect((await as(w.tokens.branchA).get(`/branches/${w.branchA._id}/payroll-runs`)).status).toBe(403);
    const w2 = await seedWorld({ managerFlags: { viewPayroll: false } });
    expect((await as(w2.tokens.manager).get(`/branches/${w2.branchA._id}/payroll-runs`)).status).toBe(403);
  });
  it('day-end: branch cannot approve, manager cannot reopen', async () => {
    const d = dayOffset(0);
    expect((await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/closures/${d}/approve`)).status).toBe(403);
    expect((await as(w.tokens.manager).post(`/branches/${w.branchA._id}/closures/${d}/reopen`, { reason: 'x' })).status).toBe(403);
  });
  it('only owner manages managers', async () => {
    expect((await as(w.tokens.manager).get('/business/managers')).status).toBe(403);
  });
});

describe('Customer phone masking (PRD §3)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  const listOf = (body: any) => body.customers || body;

  it('owner sees full numbers in the list', async () => {
    const res = await as(w.tokens.owner).get('/customers');
    expect(listOf(res.body).find((c: any) => c.name === 'Priya Shah').phone).toBe('+919876543210');
  });

  it.each(['manager', 'branchA'] as const)('%s sees masked numbers in lists', async (who) => {
    const res = await as(w.tokens[who]).get('/customers');
    const c = listOf(res.body).find((c: any) => c.name === 'Priya Shah');
    expect(c.phone).toBe('98XXXXXX10');
  });

  it('branch login sees a masked number on the customer detail', async () => {
    const res = await as(w.tokens.branchA).get(`/customers/${w.customer._id}`);
    expect(res.body.phone).toBe('98XXXXXX10');
  });

  it('reveal returns the full number and writes customer.phone_reveal to the audit log', async () => {
    const res = await as(w.tokens.branchA).post(`/customers/${w.customer._id}/reveal`);
    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('+919876543210');
    const log = await AuditLog.findOne({ businessId: w.business._id, action: 'customer.phone_reveal' });
    expect(log).toBeTruthy();
  });

  it('branch login can still find a customer by typing the full phone', async () => {
    const res = await as(w.tokens.branchA).get('/customers?q=9876543210');
    expect(listOf(res.body).length).toBe(1);
  });

  it('masked number is not leaked through the search response of another field', async () => {
    const res = await as(w.tokens.branchA).get('/customers?q=Priya');
    expect(JSON.stringify(res.body)).not.toContain('9876543210');
  });
});
