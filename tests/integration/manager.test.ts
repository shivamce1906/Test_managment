import '../helpers/testEnv';
import { useTestDb } from '../helpers/db';
import { as, createUser, seedWorld, serviceLine, tokenFor, World } from '../helpers/factory';
import { AuditLog } from '../../src/models';
import { getBusinessDate } from '../../src/utils';

const week = (open = '10:00', close = '20:00') => [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open, close, closed: false }));

describe('Manager: session config', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('/auth/me carries the read-only config with the effective discount limit for each role', async () => {
    const owner = await as(w.tokens.owner).get('/auth/me');
    expect(owner.body.config).toMatchObject({ gst: { enabled: true, rateBps: 1800 }, fyStartMonth: expect.any(Number), discountLimitBps: 10000, payroll: { pf: false } });

    const mgr = await as(w.tokens.manager).get('/auth/me');
    expect(mgr.body.config.discountLimitBps).toBe(2000); // business managerBps
    expect(mgr.body.config).not.toHaveProperty('ownerWhatsappPhone');
    expect(mgr.body.branches.map((b: any) => b.code)).toEqual(['SRT1']);

    const capped = await createUser(w.business._id, { role: 'manager', branchIds: [w.branchA._id], flags: { maxDiscountBps: 1500 } });
    expect((await as(tokenFor(capped)).get('/auth/me')).body.config.discountLimitBps).toBe(1500);

    expect((await as(w.tokens.branchA).get('/auth/me')).body.config.discountLimitBps).toBe(1000);
    expect((await as(w.tokens.manager).get('/business/settings')).status).toBe(403);
  });
});

describe('Manager: branch settings (editBranch)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld({ managerFlags: { editBranch: true } });
  });

  it('edits hours, holidays and stations of an own branch, never another branch', async () => {
    const r = await as(w.tokens.manager).patch(`/business/branches/${w.branchA._id}`, {
      hours: week('09:00', '21:00'), holidays: [{ date: '2026-11-08', name: 'Diwali' }], stations: 7,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ stations: 7, holidays: [{ date: '2026-11-08', name: 'Diwali' }] });
    expect(r.body.hours[0]).toMatchObject({ open: '09:00', close: '21:00' });
    expect(await AuditLog.exists({ action: 'branch.update', entityId: w.branchA._id })).toBeTruthy();

    expect((await as(w.tokens.manager).patch(`/business/branches/${w.branchB._id}`, { stations: 2 })).status).toBe(403);
  });

  it('needs the flag; the owner switches it on and off', async () => {
    const plain = await createUser(w.business._id, { role: 'manager', branchIds: [w.branchA._id], flags: {} });
    expect((await as(tokenFor(plain)).patch(`/business/branches/${w.branchA._id}`, { stations: 3 })).status).toBe(403);

    const on = await as(w.tokens.owner).patch(`/business/managers/${plain._id}`, { flags: { editBranch: true } });
    expect(on.body.flags.editBranch).toBe(true);
    expect((await as(tokenFor(plain)).patch(`/business/branches/${w.branchA._id}`, { stations: 3 })).status).toBe(200);
  });

  it('validates hours: unique weekdays, times on open days, open before close', async () => {
    const dup = await as(w.tokens.manager).patch(`/business/branches/${w.branchA._id}`, { hours: [...week(), { day: 0, open: '10:00', close: '20:00', closed: false }] });
    expect(dup.status).toBe(400);
    expect(dup.body.error.fields['hours.7.day']).toBe('Each weekday may appear only once');

    const backwards = await as(w.tokens.manager).patch(`/business/branches/${w.branchA._id}`, { hours: [{ day: 1, open: '20:00', close: '10:00', closed: false }] });
    expect(backwards.body.error.fields['hours.0.close']).toBe('close must be after open');

    const closedDay = await as(w.tokens.manager).patch(`/business/branches/${w.branchA._id}`, { hours: [{ day: 1, closed: true }] });
    expect(closedDay.status).toBe(200);
  });
});

describe('Manager: branch logins', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('lists only own branch logins and toggles markAttendance on them', async () => {
    const list = await as(w.tokens.manager).get('/business/branch-logins');
    expect(list.status).toBe(200);
    expect(list.body.map((u: any) => u.name)).toEqual(['Vesu Login']);
    expect(list.body[0]).not.toHaveProperty('passwordHash');

    const on = await as(w.tokens.manager).patch(`/business/branch-logins/${w.branchLoginA._id}`, { markAttendance: true });
    expect(on.status).toBe(200);
    expect(on.body.flags.markAttendance).toBe(true);
    expect((await as(w.tokens.branchA).post(`/staff/branches/${w.branchA._id}/attendance`, { entries: [{ staffId: w.stylist1._id.toString(), status: 'present' }] })).status).toBe(200);

    expect((await as(w.tokens.manager).patch(`/business/branch-logins/${w.branchLoginB._id}`, { markAttendance: true })).status).toBe(403);
    expect((await as(w.tokens.manager).get('/business/managers')).status).toBe(403);
    expect((await as(w.tokens.manager).post(`/business/users/${w.branchLoginA._id}/password`, { password: 'Newpass123' })).status).toBe(403);
  });
});

describe('Manager: customers', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('sees full phone numbers; branch logins still see them masked; export needs manageCustomers', async () => {
    const list = await as(w.tokens.manager).get('/customers');
    expect(list.body.customers[0].phone).toBe('+919876543210');
    expect((await as(w.tokens.manager).get(`/customers/${w.customer._id}`)).body.phone).toBe('+919876543210');
    expect((await as(w.tokens.branchA).get('/customers')).body.customers[0].phone).toMatch(/X/);
    expect((await as(w.tokens.manager).get('/customers/export')).status).toBe(403);
  });
});

describe('Manager: staff stay inside own branches', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('lists, opens and edits only own-branch staff, rosters and leave', async () => {
    const list = await as(w.tokens.manager).get('/staff');
    expect(list.body.map((s: any) => s.name).sort()).toEqual(['Riya Reception', 'Sam Stylist', 'Tara Stylist']);
    expect((await as(w.tokens.manager).get(`/staff?branchId=${w.branchB._id}`)).status).toBe(403);
    expect((await as(w.tokens.manager).get(`/staff/${w.stylistB._id}`)).status).toBe(404);
    expect((await as(w.tokens.manager).patch(`/staff/${w.stylistB._id}`, { name: 'X' })).status).toBe(404);
    expect((await as(w.tokens.manager).get(`/staff/${w.stylistB._id}/roster`)).status).toBe(404);
    const weekly = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '10:00', end: '19:00', off: false }));
    expect((await as(w.tokens.manager).patch(`/staff/${w.stylistB._id}/roster`, { weekly, overrides: [] })).status).toBe(404);

    const leaveB = await as(w.tokens.owner).post(`/staff/branches/${w.branchB._id}/leaves`, { staffId: w.stylistB._id.toString(), from: '2027-01-10', to: '2027-01-11', type: 'paid', reason: 'x' });
    expect((await as(w.tokens.manager).patch(`/staff/leaves/${leaveB.body._id}/status`, { status: 'rejected' })).status).toBe(404);

    // own branch still works; the owner still sees everyone
    expect((await as(w.tokens.manager).get(`/staff/${w.stylist1._id}/roster`)).status).toBe(200);
    expect((await as(w.tokens.owner).get('/staff')).body).toHaveLength(4);
    expect((await as(w.tokens.branchB).get('/staff')).body.map((s: any) => s.name)).toEqual(['Bina Stylist']);
  });
});

describe('Manager: other branches are out of reach everywhere', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld({ gst: false });
  });

  it('gets 403 for other-branch screens and 404 for other-branch records', async () => {
    const m = as(w.tokens.manager);
    const B = w.branchB._id.toString();
    const today = getBusinessDate();
    for (const url of [`/dashboard?branchId=${B}`, `/branches/${B}/appointments`, `/staff/branches/${B}/attendance`, `/branches/${B}/stock`, `/branches/${B}/closures/${today}`, `/reports/sales-summary?branchId=${B}`, `/audit-logs?branchId=${B}`]) {
      expect([url, (await as(w.tokens.manager).get(url)).status]).toEqual([url, 403]);
    }
    const billB = await as(w.tokens.owner).post(`/branches/${B}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylistB._id)], payments: [{ mode: 'cash', amountPaise: 100000 }],
    });
    expect((await m.get(`/bills/${billB.body._id}`)).status).toBe(404);
    const runB = await as(w.tokens.owner).post(`/branches/${B}/payroll-runs`, { month: today.slice(0, 7) });
    expect((await as(w.tokens.manager).get(`/payroll-runs/${runB.body._id}`)).status).toBe(404);
    expect((await as(w.tokens.manager).post(`/branches/${B}/payroll-runs`, { month: today.slice(0, 7) })).status).toBe(403);
  });

  it('without the new flags: catalogue, plans and products are view only and owner-granted actions stay closed', async () => {
    const m = () => as(w.tokens.manager);
    expect((await m().get('/services')).status).toBe(200);
    expect((await m().post('/categories', { name: 'X', gender: 'unisex' })).status).toBe(403);
    expect((await m().patch(`/services/${w.haircut._id}`, { basePricePaise: 1 })).status).toBe(403);
    expect((await m().post('/products', { name: 'P', type: 'retail', purchaseUnit: 'pc', useUnit: 'pc', unitsPerPurchase: 1 })).status).toBe(403);
    expect((await m().post('/plans', { type: 'voucher', name: 'V', pricePaise: 1000, validityDays: 30, voucher: { valuePaise: 1000 } })).status).toBe(403);
    expect((await m().get('/audit-logs/export')).status).toBe(403);
    expect((await m().post(`/customers/${w.customer._id}/wallet/adjust`, { amountPaise: 100, reason: 'x' })).status).toBe(403);
    // branch prices with editBranchPrices, own branch only
    expect((await m().patch(`/services/${w.haircut._id}/branch-prices`, { branchId: w.branchA._id.toString(), pricePaise: 110000 })).status).toBe(200);
    expect((await m().patch(`/services/${w.haircut._id}/branch-prices`, { branchId: w.branchB._id.toString(), pricePaise: 110000 })).status).toBe(403);
  });
});

describe('Manager: approvals', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld({ gst: false });
  });

  it("can't approve or reject a bill they sent for approval; the owner or another manager can", async () => {
    const held = await as(w.tokens.manager).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), lines: [serviceLine(w.haircut._id, w.stylist1._id)],
      billDiscount: { type: 'pct', value: 5000 }, payments: [{ mode: 'cash', amountPaise: 50000 }],
    });
    expect(held.body.status).toBe('awaiting_approval');
    expect(held.body.approval.requestedBy).toBe(w.manager._id.toString());

    const self = await as(w.tokens.manager).post(`/bills/${held.body._id}/decide`, { decision: 'approve' });
    expect(self.status).toBe(403);
    expect(self.body.error.message).toBe('You cannot approve or reject a bill you sent for approval');
    expect((await as(w.tokens.manager).post(`/bills/${held.body._id}/decide`, { decision: 'reject', reason: 'x' })).status).toBe(403);

    const other = await createUser(w.business._id, { role: 'manager', branchIds: [w.branchA._id] });
    expect((await as(tokenFor(other)).post(`/bills/${held.body._id}/decide`, { decision: 'approve' })).body.status).toBe('paid');

    // a front-desk bill held for approval is still the manager's to decide
    const desk = await as(w.tokens.branchA).post(`/branches/${w.branchA._id}/bills`, {
      customerId: w.customer._id.toString(), billedByStaffId: w.receptionist._id.toString(),
      lines: [serviceLine(w.haircut._id, w.stylist1._id)], billDiscount: { type: 'pct', value: 5000 }, payments: [{ mode: 'cash', amountPaise: 50000 }],
    });
    expect((await as(w.tokens.manager).post(`/bills/${desk.body._id}/decide`, { decision: 'approve' })).status).toBe(200);
  });
});

describe('Manager: owner-granted flags', () => {
  useTestDb();
  let w: World;
  const ALL = { manageCatalogue: true, manageCustomers: true, manageFinance: true, managePayroll: true, viewPayroll: true, exportAudit: true, manageMarketing: true };
  beforeEach(async () => {
    w = await seedWorld({ gst: false, managerFlags: ALL });
  });

  it('a manager without the flags is refused every gated action', async () => {
    const plain = as(tokenFor(await createUser(w.business._id, { role: 'manager', branchIds: [w.branchA._id], flags: { viewPayroll: true } })));
    expect((await plain.post('/categories', { name: 'X', gender: 'unisex' })).status).toBe(403);
    expect((await plain.get('/customers/export')).status).toBe(403);
    expect((await plain.post(`/customers/${w.customer._id}/wallet/adjust`, { amountPaise: 100, reason: 'goodwill' })).status).toBe(403);
    expect((await plain.post(`/branches/${w.branchA._id}/closures/${getBusinessDate()}/reopen`, { reason: 'Missed a bill' })).status).toBe(403);
    expect((await plain.get('/audit-logs/export')).status).toBe(403);
    expect((await plain.patch('/whatsapp/automations/birthday', { enabled: true })).status).toBe(403);
    const run = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/payroll-runs`, { month: getBusinessDate().slice(0, 7) });
    expect((await plain.post(`/payroll-runs/${run.body._id}/lock`)).status).toBe(403);
  });

  it('manageCatalogue: creates and edits categories, services, products and plans (business-wide)', async () => {
    const m = () => as(w.tokens.manager);
    expect((await m().post('/categories', { name: 'Spa', gender: 'unisex' })).status).toBe(201);
    const svc = await m().patch(`/services/${w.haircut._id}`, { basePricePaise: 99000 });
    expect(svc.status).toBe(200);
    expect(svc.body.basePricePaise).toBe(99000);
    expect((await m().post('/products', { name: 'Gel', type: 'retail', purchaseUnit: 'pc', useUnit: 'pc', unitsPerPurchase: 1, purchasePricePaise: 100 })).status).toBe(201);
    expect((await m().post('/plans', { type: 'membership', name: 'Gold', pricePaise: 200000, validityDays: 365, membership: { serviceDiscountBps: 2000 } })).status).toBe(201);
  });

  it('manageCustomers: exports customers and adjusts wallets', async () => {
    const exp = await as(w.tokens.manager).get('/customers/export');
    expect(exp.status).toBe(200);
    expect(exp.headers['content-type']).toMatch(/spreadsheet/);
    expect((await as(w.tokens.manager).post(`/customers/${w.customer._id}/wallet/adjust`, { amountPaise: 5000, reason: 'goodwill' })).status).toBe(200);
  });

  it('manageFinance: deletes own-branch expenses and can reach reopen, never for another branch', async () => {
    const e = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/expenses`, { category: 'tea_snacks', amountPaise: 20000, mode: 'cash', paidFrom: 'till' });
    expect((await as(w.tokens.manager).delete(`/expenses/${e.body._id}`)).status).toBe(200);
    const eB = await as(w.tokens.owner).post(`/branches/${w.branchB._id}/expenses`, { category: 'tea_snacks', amountPaise: 20000, mode: 'cash', paidFrom: 'till' });
    expect((await as(w.tokens.manager).delete(`/expenses/${eB.body._id}`)).status).not.toBe(200);
    const today = getBusinessDate();
    expect((await as(w.tokens.manager).post(`/branches/${w.branchA._id}/closures/${today}/reopen`, { reason: 'Missed a bill' })).status).toBe(404); // passes the gate, no closure yet
    expect((await as(w.tokens.manager).post(`/branches/${w.branchB._id}/closures/${today}/reopen`, { reason: 'Missed a bill' })).status).toBe(403);
  });

  it('managePayroll: locks own-branch runs; exportAudit: exports the audit log', async () => {
    const run = await as(w.tokens.owner).post(`/branches/${w.branchA._id}/payroll-runs`, { month: getBusinessDate().slice(0, 7) });
    expect((await as(w.tokens.manager).post(`/payroll-runs/${run.body._id}/lock`)).status).not.toBe(403);
    expect((await as(w.tokens.manager).get('/audit-logs/export')).status).toBe(200);
  });

  it('the owner grants a flag and /auth/me shows it straight away', async () => {
    const plain = await createUser(w.business._id, { role: 'manager', branchIds: [w.branchA._id], flags: {} });
    expect((await as(tokenFor(plain)).get('/auth/me')).body.user.flags.manageFinance).toBe(false);
    const on = await as(w.tokens.owner).patch(`/business/managers/${plain._id}`, { flags: { manageFinance: true } });
    expect(on.body.flags).toMatchObject({ manageFinance: true, manageCatalogue: false });
    expect((await as(tokenFor(plain)).get('/auth/me')).body.user.flags.manageFinance).toBe(true);
  });
});
