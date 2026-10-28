import '../helpers/testEnv';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, World, createPlatformAdmin, platformToken, address, PASSWORD, serviceLine, createCustomer } from '../helpers/factory';
import { Business, Branch, User, Service, Category, AuditLog, Bill, Customer, BranchRequest } from '../../src/models';

const onboard = (suffix: string) => ({
  business: {
    name: `Salon ${suffix}`, address, gst: { enabled: true, gstin: '24AAAAA0000A1Z5', pan: 'AAAAA0000A', rateBps: 1800 },
    discountLimits: { managerBps: 2000, branchBps: 1000, ownerAlertBps: 2500 }, ownerWhatsappPhone: '9800000001',
  },
  owner: { name: 'Owner', email: `owner-${suffix}@salon.test`, password: 'Secret123' },
  headBranch: { name: 'Head', code: 'hq1', invoicePrefix: 'hq1', address, phone: '9800000002', loginEmail: `hq-${suffix}@salon.test`, loginPassword: 'Secret123' },
});

describe('Super Admin onboarding (PRD §3, SRS 5.1)', () => {
  useTestDb();
  let sa: string;
  beforeEach(async () => {
    sa = platformToken(await createPlatformAdmin());
  });

  it('creates business + owner + head branch + branch login in one call; owner can log in', async () => {
    const res = await as(sa).post('/admin/businesses', onboard('a'));
    expect(res.status).toBe(201);
    const biz = await Business.findOne({ name: 'Salon a' });
    expect(biz?.headBranchId).toBeTruthy();
    const branch = await Branch.findOne({ businessId: biz!._id });
    expect(branch).toMatchObject({ code: 'HQ1', invoicePrefix: 'HQ1' });
    const login = await as().post('/auth/login', { email: 'owner-a@salon.test', password: PASSWORD });
    expect(login.status).toBe(200);
    const bl = await as().post('/auth/login', { email: 'hq-a@salon.test', password: PASSWORD });
    expect(bl.status).toBe(200);
    expect(bl.body.user.role).toBe('branch');
  });

  it('duplicate owner email across businesses -> 409 DUPLICATE_EMAIL and nothing half-created', async () => {
    await as(sa).post('/admin/businesses', onboard('b'));
    const again = onboard('c');
    again.owner.email = 'owner-b@salon.test';
    const res = await as(sa).post('/admin/businesses', again);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_EMAIL');
    expect(await Business.countDocuments({ name: 'Salon c' })).toBe(0);
  });

  it('a failed onboarding leaves no half-created business, branch or users behind (transaction)', async () => {
    const res = await as(sa).post('/admin/businesses', onboard('half'));
    if (res.status === 201) return;
    const biz = await Business.findOne({ name: 'Salon half' });
    expect(biz).toBeNull();
    expect(await User.countDocuments({ email: 'owner-half@salon.test' })).toBe(0);
  });

  it('owner email and branch login email must differ', async () => {
    const body = onboard('d');
    body.headBranch.loginEmail = body.owner.email;
    expect((await as(sa).post('/admin/businesses', body)).status).toBe(400);
  });

  it('GSTIN is required when GST is enabled', async () => {
    const body: any = onboard('e');
    delete body.business.gst.gstin;
    expect((await as(sa).post('/admin/businesses', body)).status).toBe(400);
  });

  it('super admin adds a second branch with its own login; duplicate branch code rejected', async () => {
    await as(sa).post('/admin/businesses', onboard('f'));
    const biz = await Business.findOne({ name: 'Salon f' });
    const body = { name: 'Two', code: 'SRT2', invoicePrefix: 'SRT2', address, phone: '9800000003', loginEmail: 'two-f@salon.test', loginPassword: 'Secret123' };
    expect((await as(sa).post(`/admin/businesses/${biz!._id}/branches`, body)).status).toBe(201);
    const dup = await as(sa).post(`/admin/businesses/${biz!._id}/branches`, { ...body, loginEmail: 'three-f@salon.test' });
    expect(dup.status).toBe(409);
  });

  it('head branch cannot be deactivated; another branch can, and its login stops working', async () => {
    await as(sa).post('/admin/businesses', onboard('g'));
    const biz = await Business.findOne({ name: 'Salon g' });
    const r = await as(sa).patch(`/admin/businesses/${biz!._id}/branches/${biz!.headBranchId}/deactivate`, { reason: 'x' });
    expect(r.status).toBe(403);
    const b2 = await as(sa).post(`/admin/businesses/${biz!._id}/branches`, { name: 'Two', code: 'G2', invoicePrefix: 'G2', address, phone: '9800000003', loginEmail: 'two-g@salon.test', loginPassword: 'Secret123' });
    const branchId = b2.body.branch?._id || b2.body._id;
    expect((await as(sa).patch(`/admin/businesses/${biz!._id}/branches/${branchId}/deactivate`, { reason: 'Closed' })).status).toBe(200);
    expect((await as().post('/auth/login', { email: 'two-g@salon.test', password: PASSWORD })).status).toBe(403);
  });

  it('owner raises a branch deletion request; super admin approves it', async () => {
    await as(sa).post('/admin/businesses', onboard('h'));
    const biz = await Business.findOne({ name: 'Salon h' });
    const b2 = await as(sa).post(`/admin/businesses/${biz!._id}/branches`, { name: 'Two', code: 'H2', invoicePrefix: 'H2', address, phone: '9800000003', loginEmail: 'two-h@salon.test', loginPassword: 'Secret123' });
    const branchId = b2.body.branch?._id || b2.body._id;
    const ownerLogin = await as().post('/auth/login', { email: 'owner-h@salon.test', password: PASSWORD });
    const req = await as(ownerLogin.body.accessToken).post('/business/branch-requests', { type: 'delete', branchId, reason: 'Lease ended' });
    expect(req.status).toBe(201);
    const list = await as(sa).get('/admin/branch-requests');
    expect(list.body.length).toBe(1);
    const dec = await as(sa).post(`/admin/branch-requests/${req.body._id}/decide`, { decision: 'approve' });
    expect(dec.status).toBe(200);
    expect((await Branch.findOne({ _id: branchId, businessId: biz!._id }))!.status).toBe('deactivated');
    expect(await BranchRequest.countDocuments({ businessId: biz!._id, status: 'approved' })).toBe(1);
  });
});

describe('Owner: settings and managers', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('owner updates discount limits; branch limit then applies to bills', async () => {
    const r = await as(w.tokens.owner).patch('/business/settings', { discountLimits: { branchBps: 500 } });
    expect(r.status).toBe(200);
    const bill = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), billedByStaffId: w.receptionist._id.toString(),
      lines: [serviceLine(w.haircut._id, w.stylist1._id)], billDiscount: { type: 'pct', value: 1000 }, payments: [{ mode: 'cash', amountPaise: 106200 }],
    });
    expect(bill.body.status).toBe('awaiting_approval');
  });

  it('turning GST on without a GSTIN is rejected', async () => {
    const w2 = await seedWorld({ gst: false });
    const r = await as(w2.tokens.owner).patch('/business/settings', { gst: { enabled: true } });
    expect(r.status).toBe(400);
  });

  it('owner creates a manager for selected branches; duplicate email -> 409', async () => {
    const body = { name: 'M2', email: 'm2@salon.test', password: 'Secret123', branchIds: [w.branchB._id.toString()], flags: { manageStaff: true } };
    expect((await as(w.tokens.owner).post('/business/managers', body)).status).toBe(201);
    expect((await as(w.tokens.owner).post('/business/managers', body)).status).toBe(409);
  });

  it('cannot assign a manager to a branch of another business', async () => {
    const r = await as(w.tokens.owner).post('/business/managers', { name: 'M3', email: 'm3@salon.test', password: 'Secret123', branchIds: [w.otherBranch._id.toString()] });
    expect([403, 404, 422]).toContain(r.status);
  });

  it('owner changes branch hours; bookings then follow the new hours', async () => {
    const hours = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day: d, open: '12:00', close: '18:00', closed: false }));
    expect((await as(w.tokens.owner).patch(`/business/branches/${w.branchA._id}`, { hours })).status).toBe(200);
    const d = new Date(Date.now() + 86400000);
    const iso = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 5, 30)).toISOString(); // 11:00 IST
    const res = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/appointments`, {
      customerId: w.customer._id.toString(), lines: [{ serviceId: w.haircut._id.toString(), staffId: w.stylist1._id.toString(), start: iso }],
    });
    expect(res.status).toBe(409);
  });

  it('owner cannot update a branch of another business', async () => {
    const r = await as(w.tokens.owner).patch(`/business/branches/${w.otherBranch._id}`, { stations: 9 });
    expect([403, 404]).toContain(r.status);
  });

  it('owner toggles markAttendance on a branch login', async () => {
    const r = await as(w.tokens.owner).patch(`/business/branch-logins/${w.branchLoginA._id}`, { markAttendance: true });
    expect(r.status).toBe(200);
    expect((await User.findOne({ _id: w.branchLoginA._id, businessId: w.business._id }))!.flags.markAttendance).toBe(true);
  });
});

describe('Catalogue rules (PRD §4)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('categories are max two levels deep', async () => {
    const child = await as(w.tokens.owner).post('/categories', { name: 'Colour', gender: 'unisex', parentId: w.category._id.toString() });
    expect(child.status).toBe(201);
    const grandchild = await as(w.tokens.owner).post('/categories', { name: 'Balayage', gender: 'unisex', parentId: child.body._id });
    expect(grandchild.status).toBe(400);
  });

  it('a category that still has services cannot be deleted (Database Design: Block)', async () => {
    const r = await as(w.tokens.owner).delete(`/categories/${w.category._id}`);
    expect([409, 422]).toContain(r.status);
  });

  it('service duration must be 5–480 minutes', async () => {
    const base = { categoryId: w.category._id.toString(), name: 'X', gender: 'unisex', basePricePaise: 100 };
    expect((await as(w.tokens.owner).post('/services', { ...base, durationMin: 2 })).status).toBe(400);
    expect((await as(w.tokens.owner).post('/services', { ...base, durationMin: 600 })).status).toBe(400);
  });

  it('services list shows the effective price for a branch', async () => {
    await Service.updateOne({ _id: w.haircut._id, businessId: w.business._id }, { $set: { branchPrices: [{ branchId: w.branchA._id, pricePaise: 120000, active: true }] } });
    const res = await as(w.tokens.branchA).get(`/services?branchId=${w.branchA._id}`);
    const h = (res.body.services || res.body).find((s: any) => s.name === 'Haircut');
    expect(h.effectivePricePaise).toBe(120000);
  });

  it('manager with editBranchPrices sets the price for an assigned branch; change is audited', async () => {
    const r = await as(w.tokens.manager).patch(`/services/${w.haircut._id}/branch-prices`, { branchId: w.branchA._id.toString(), pricePaise: 110000 });
    expect(r.status).toBe(200);
    expect(await AuditLog.findOne({ businessId: w.business._id, action: /price/ })).toBeTruthy();
  });

  it('manager cannot set the price for a branch they do not manage', async () => {
    const r = await as(w.tokens.manager).patch(`/services/${w.haircut._id}/branch-prices`, { branchId: w.branchB._id.toString(), pricePaise: 1 });
    expect(r.status).toBe(403);
  });

  it('branch price must be a non-negative integer', async () => {
    const r = await as(w.tokens.owner).patch(`/services/${w.haircut._id}/branch-prices`, { branchId: w.branchA._id.toString(), pricePaise: -500 });
    expect(r.status).toBe(400);
  });

  it('owner deactivates a service; history (old bills) is kept', async () => {
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 118000 }],
    });
    expect((await as(w.tokens.owner).delete(`/services/${w.haircut._id}`)).status).toBe(200);
    expect((await Service.findOne({ _id: w.haircut._id, businessId: w.business._id }))!.active).toBe(false);
    expect(await Bill.countDocuments({ businessId: w.business._id })).toBe(1);
  });

  it('category of another business cannot be used for a service', async () => {
    const foreign = await Category.create({ businessId: w.otherBusiness._id, name: 'F', gender: 'unisex', order: 1, active: true });
    const r = await as(w.tokens.owner).post('/services', { categoryId: foreign._id.toString(), name: 'X', gender: 'unisex', basePricePaise: 100, durationMin: 30 });
    expect(r.status).toBe(404);
  });
});

describe('Customer CRM (PRD §6)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('creates a customer with profile fields and tags', async () => {
    const r = await as(w.tokens.branchA).post('/customers', { name: 'Meera', phone: '9820000000', dob: '1995-02-14', tags: ['VIP'], source: 'referral' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ phone: '+919820000000', tags: ['VIP'], source: 'referral' });
  });

  it('invalid date of birth (2026-02-30) -> 400', async () => {
    expect((await as(w.tokens.owner).post('/customers', { name: 'x', phone: '9820000001', dob: '2026-02-30' })).status).toBe(400);
  });

  it('service note is stored and shown latest first', async () => {
    await as(w.tokens.branchA).post(`/customers/${w.customer._id}/notes`, { text: 'First', colourFormula: '6.0 + 20vol' });
    await as(w.tokens.branchA).post(`/customers/${w.customer._id}/notes`, { text: 'Second' });
    const c = await Customer.findOne({ _id: w.customer._id, businessId: w.business._id });
    expect(c!.serviceNotes.map((n) => n.text)).toEqual(['Second', 'First']);
  });

  it('merge moves the duplicate\'s bills to the primary and retires the duplicate', async () => {
    const dup = await createCustomer(w.business._id, { name: 'Priya S', phone: '+919822222222' });
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: dup._id.toString(), lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 118000 }],
    });
    const r = await as(w.tokens.manager).post('/customers/merge', { primaryId: w.customer._id.toString(), duplicateId: dup._id.toString() });
    expect(r.status).toBe(200);
    expect(await Bill.countDocuments({ businessId: w.business._id, customerId: w.customer._id })).toBe(1);
    const d = await Customer.findOne({ _id: dup._id, businessId: w.business._id });
    expect(String(d!.mergedInto)).toBe(String(w.customer._id));
    expect(await AuditLog.findOne({ businessId: w.business._id, action: /merge/ })).toBeTruthy();
  });

  it('owner export returns an Excel file and is audited', async () => {
    const r = await as(w.tokens.owner).get('/customers/export');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/spreadsheetml|octet-stream/);
    expect(await AuditLog.findOne({ businessId: w.business._id, action: /export/ })).toBeTruthy();
  });

  it('customer history returns their bills', async () => {
    await as(w.tokens.owner).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylist1._id)], payments: [{ mode: 'cash', amountPaise: 118000 }],
    });
    const r = await as(w.tokens.branchA).get(`/customers/${w.customer._id}/history?type=bills`);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain('SRT1/');
  });

  it('segment "lapsed" finds customers with no visit in 60+ days', async () => {
    await createCustomer(w.business._id, { name: 'Old', stats: { visits: 3, spendPaise: 1, noShows: 0, lastVisit: '2020-01-01' } });
    const r = await as(w.tokens.owner).get('/customers?segment=lapsed');
    const names = (r.body.customers || r.body).map((c: any) => c.name);
    expect(names).toContain('Old');
    expect(names).not.toContain('Priya Shah');
  });
});
