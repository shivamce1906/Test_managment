import '../helpers/testEnv';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, World, PASSWORD, createStaff, address } from '../helpers/factory';
import { AuditLog, Business, Category, Product, Roster, Service, User } from '../../src/models';

const login = (email: string, password = PASSWORD) => as().post('/auth/login', { email, password });

describe('Owner setup (Phase 1)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  describe('session', () => {
    it('/auth/me returns the business and every branch for an owner', async () => {
      const res = await as(w.tokens.owner).get('/auth/me');
      expect(res.status).toBe(200);
      expect(res.body.business).toMatchObject({ name: w.business.name, status: 'active', gst: { enabled: true } });
      expect(res.body.branches.map((b: any) => b.code)).toEqual(['SRT1', 'SRT2']);
      expect(res.body.user.role).toBe('owner');
    });

    it('/auth/me returns only assigned branches for a manager', async () => {
      const res = await as(w.tokens.manager).get('/auth/me');
      expect(res.body.branches.map((b: any) => b.code)).toEqual(['SRT1']);
    });
  });

  describe('settings', () => {
    it('a partial nested update keeps the fields that were not sent', async () => {
      const res = await as(w.tokens.owner).patch('/business/settings', { gst: { rateBps: 500 }, discountLimits: { branchBps: 500 } });
      expect(res.status).toBe(200);
      expect(res.body.gst).toMatchObject({ enabled: true, gstin: '24AAAAA0000A1Z5', rateBps: 500, sac: '9983' });
      expect(res.body.discountLimits).toEqual({ managerBps: 2000, branchBps: 500, ownerAlertBps: 2500 });
    });

    it('turning GST on without a GSTIN returns a field error', async () => {
      const w2 = await seedWorld({ gst: false });
      const res = await as(w2.tokens.owner).patch('/business/settings', { gst: { enabled: true } });
      expect(res.status).toBe(400);
      expect(res.body.error.fields).toHaveProperty(['gst.gstin']);
      expect((await Business.findById(w2.business._id))!.gst.enabled).toBe(false);
    });

    it('payroll settings merge one level deeper', async () => {
      const res = await as(w.tokens.owner).patch('/business/settings', { payroll: { pf: { enabled: true } } });
      expect(res.status).toBe(200);
      expect(res.body.payroll.pf).toMatchObject({ enabled: true, employeePct: 12, wageCeilingPaise: 1500000 });
      expect(res.body.payroll.esi.enabled).toBe(false);
    });
  });

  describe('team', () => {
    it('create manager returns no password hash', async () => {
      const res = await as(w.tokens.owner).post('/business/managers', {
        name: 'M2', email: 'm2@salon.test', password: 'Secret123', branchIds: [w.branchB._id.toString()], flags: { manageStaff: true },
      });
      expect(res.status).toBe(201);
      expect(res.body.passwordHash).toBeUndefined();
      expect((await login('m2@salon.test')).status).toBe(200);
    });

    it('update manager returns no hash; a flag change keeps the session, a branch change ends it', async () => {
      const live = await login(w.manager.email);
      const flags = await as(w.tokens.owner).patch(`/business/managers/${w.manager._id}`, { flags: { viewPayroll: false } });
      expect(flags.status).toBe(200);
      expect(flags.body.passwordHash).toBeUndefined();
      expect((await as(live.body.accessToken).get('/auth/me')).status).toBe(200);
      await as(w.tokens.owner).patch(`/business/managers/${w.manager._id}`, { branchIds: [w.branchA._id.toString(), w.branchB._id.toString()] });
      expect((await as(live.body.accessToken).get('/auth/me')).status).toBe(401);
    });

    it('a manager cannot be moved to another business\'s branch', async () => {
      const res = await as(w.tokens.owner).patch(`/business/managers/${w.manager._id}`, { branchIds: [w.otherBranch._id.toString()] });
      expect(res.status).toBe(404);
    });

    it('branch login flags take { markAttendance } and return no hash; bad body -> 400', async () => {
      const res = await as(w.tokens.owner).patch(`/business/branch-logins/${w.branchLoginA._id}`, { markAttendance: true });
      expect(res.status).toBe(200);
      expect(res.body.flags.markAttendance).toBe(true);
      expect(res.body.passwordHash).toBeUndefined();
      expect((await as(w.tokens.owner).patch(`/business/branch-logins/${w.branchLoginA._id}`, { flags: { markAttendance: true } })).status).toBe(400);
    });

    it('owner resets a manager password: 204, old sessions end, new password works', async () => {
      const live = await login(w.manager.email);
      const res = await as(w.tokens.owner).post(`/business/users/${w.manager._id}/password`, { password: 'NewPass123' });
      expect(res.status).toBe(204);
      expect((await as(live.body.accessToken).get('/auth/me')).status).toBe(401);
      expect((await login(w.manager.email, 'NewPass123')).status).toBe(200);
    }, 30000);

    it('owner cannot reset their own password here, nor a user of another business', async () => {
      expect((await as(w.tokens.owner).post(`/business/users/${w.owner._id}/password`, { password: 'NewPass123' })).status).toBe(403);
      expect((await as(w.tokens.owner).post(`/business/users/${w.otherOwner._id}/password`, { password: 'NewPass123' })).status).toBe(404);
      expect((await as(w.tokens.manager).post(`/business/users/${w.branchLoginA._id}/password`, { password: 'NewPass123' })).status).toBe(403);
    });
  });

  describe('branch access', () => {
    it('another business\'s branch is a 404, a malformed id a 400', async () => {
      expect((await as(w.tokens.owner).get(`/staff/branches/${w.otherBranch._id}/attendance`)).status).toBe(404);
      expect((await as(w.tokens.owner).get('/staff/branches/nope/attendance')).status).toBe(400);
      expect((await as(w.tokens.owner).get('/staff/nope')).status).toBe(400);
    });
  });

  describe('catalogue', () => {
    it('a category in use cannot be deleted; once its services are off it can, and that is audited', async () => {
      const blocked = await as(w.tokens.owner).delete(`/categories/${w.category._id}`);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('CATEGORY_IN_USE');
      await Service.updateMany({ businessId: w.business._id, categoryId: w.category._id }, { active: false });
      const ok = await as(w.tokens.owner).delete(`/categories/${w.category._id}`);
      expect(ok.status).toBe(200);
      expect(ok.body.active).toBe(false);
      expect(await AuditLog.findOne({ businessId: w.business._id, action: 'category.deactivate' })).toBeTruthy();
    });

    it('a category with sub-categories cannot become a sub-category (max two levels)', async () => {
      const top = await Category.create({ businessId: w.business._id, name: 'Skin', gender: 'unisex', order: 2, active: true });
      await as(w.tokens.owner).post('/categories', { name: 'Facial', gender: 'unisex', parentId: w.category._id.toString() });
      const res = await as(w.tokens.owner).patch(`/categories/${w.category._id}`, { parentId: top._id.toString() });
      expect(res.status).toBe(400);
    });

    it('deleting a service deactivates and audits it; an unknown id is a 404', async () => {
      const res = await as(w.tokens.owner).delete(`/services/${w.haircut._id}`);
      expect(res.status).toBe(200);
      expect(res.body.active).toBe(false);
      expect(await AuditLog.findOne({ businessId: w.business._id, action: 'service.deactivate' })).toBeTruthy();
      expect((await as(w.tokens.owner).delete('/services/64b000000000000000000000')).status).toBe(404);
    });

    it('branch price: set, hide in a branch, clear back to base; other business branch -> 404', async () => {
      const url = `/services/${w.haircut._id}/branch-prices`;
      expect((await as(w.tokens.owner).patch(url, { branchId: w.branchA._id.toString(), pricePaise: 120000 })).status).toBe(200);
      expect((await as(w.tokens.owner).patch(url, { branchId: w.branchB._id.toString(), active: false })).status).toBe(200);
      let list = (await as(w.tokens.owner).get(`/services?branchId=${w.branchB._id}`)).body;
      expect(list.find((s: any) => s.name === 'Haircut').branchActive).toBe(false);
      await as(w.tokens.owner).patch(url, { branchId: w.branchA._id.toString(), pricePaise: null });
      list = (await as(w.tokens.owner).get(`/services?branchId=${w.branchA._id}`)).body;
      expect(list.find((s: any) => s.name === 'Haircut').effectivePricePaise).toBe(100000);
      expect((await as(w.tokens.owner).patch(url, { branchId: w.otherBranch._id.toString(), pricePaise: 1 })).status).toBe(404);
      expect((await as(w.tokens.owner).patch(url, { branchId: w.branchA._id.toString() })).status).toBe(400);
    });

    it('service search is plain text and supports active=false', async () => {
      expect((await as(w.tokens.owner).get('/services?search=.*')).body).toHaveLength(0);
      expect((await as(w.tokens.owner).get('/services?search=hair')).body.map((s: any) => s.name)).toEqual(['Haircut']);
      await as(w.tokens.owner).delete(`/services/${w.haircut._id}`);
      expect((await as(w.tokens.owner).get('/services?active=false')).body.map((s: any) => s.name)).toEqual(['Haircut']);
    });

    it('a service cannot use another business\'s product, branch or staff', async () => {
      const foreign = await Product.create({
        businessId: w.otherBusiness._id, name: 'F', type: 'consumable', purchaseUnit: 'tube', useUnit: 'ml', unitsPerPurchase: 100, purchasePricePaise: 1, active: true,
      });
      const base = { categoryId: w.category._id.toString(), name: 'X', gender: 'unisex', basePricePaise: 100, durationMin: 30 };
      expect((await as(w.tokens.owner).post('/services', { ...base, consumables: [{ productId: foreign._id.toString(), qty: 1 }] })).status).toBe(404);
      expect((await as(w.tokens.owner).post('/services', { ...base, branchPrices: [{ branchId: w.otherBranch._id.toString(), pricePaise: 1 }] })).status).toBe(404);
      expect((await as(w.tokens.owner).patch(`/services/${w.haircut._id}`, { eligibleStaffIds: [w.otherOwner._id.toString()] })).status).toBe(404);
    });
  });

  describe('staff', () => {
    it('moving a staff member to another branch moves their roster', async () => {
      const res = await as(w.tokens.owner).patch(`/staff/${w.stylist2._id}`, { branchId: w.branchB._id.toString() });
      expect(res.status).toBe(200);
      await as(w.tokens.owner).get(`/staff/${w.stylist2._id}/roster`);
      const roster = await Roster.findOne({ businessId: w.business._id, staffId: w.stylist2._id });
      expect(String(roster!.branchId)).toBe(String(w.branchB._id));
    });

    it('staff list filters by branch and q (name or phone)', async () => {
      const a = await as(w.tokens.owner).get(`/staff?branchId=${w.branchA._id}&q=stylist`);
      expect(a.body.map((s: any) => s.name).sort()).toEqual(['Sam Stylist', 'Tara Stylist']);
      expect((await as(w.tokens.owner).get('/staff?status=gone')).status).toBe(400);
    });

    it('roster: a working day without times, or a repeated weekday, is a 400', async () => {
      const url = `/staff/${w.stylist1._id}/roster`;
      expect((await as(w.tokens.owner).patch(url, { weekly: [{ day: 1, off: false }] })).status).toBe(400);
      expect((await as(w.tokens.owner).patch(url, { weekly: [{ day: 1, off: true }, { day: 1, off: true }] })).status).toBe(400);
    });

    it('leave and advance must be for staff of the branch in the URL', async () => {
      const leave = await as(w.tokens.owner).post(`/staff/branches/${w.branchB._id}/leaves`, { staffId: w.stylist1._id.toString(), from: '2026-12-01', to: '2026-12-01', type: 'paid' });
      expect(leave.status).toBe(404);
      const adv = await as(w.tokens.owner).post(`/staff/branches/${w.branchB._id}/advances`, { staffId: w.stylist1._id.toString(), amountPaise: 100, date: '2026-12-01', recoveryPerMonthPaise: 100 });
      expect(adv.status).toBe(404);
    });

    it('a rostered day off counts every worked minute as overtime', async () => {
      const staff = await createStaff(w.business._id, w.branchA._id, { name: 'Off Day' });
      const date = '2026-12-02';
      await as(w.tokens.owner).patch(`/staff/${staff._id}/roster`, { weekly: [], overrides: [{ date, off: true }] });
      await as(w.tokens.owner).post(`/staff/branches/${w.branchA._id}/attendance?date=${date}`, {
        entries: [{ staffId: staff._id.toString(), status: 'present', inAt: '2026-12-02T05:30:00.000Z', outAt: '2026-12-02T07:30:00.000Z' }],
      });
      const list = await as(w.tokens.owner).get(`/staff/branches/${w.branchA._id}/attendance?date=${date}`);
      const row = list.body.find((r: any) => r.staff.name === 'Off Day');
      expect(row.attendance.overtimeMin).toBe(120);
    });
  });

  it('unused import guard', () => {
    expect(address.city).toBe('Surat');
    expect(User).toBeTruthy();
  });
});

describe('Owner setup (Phase 1): lists that populate staff', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('leaves and advances lists return 200 with the staff member populated', async () => {
    await as(w.tokens.owner).post(`/staff/branches/${w.branchA._id}/leaves`, { staffId: w.stylist1._id.toString(), from: '2026-12-01', to: '2026-12-02', type: 'paid' });
    await as(w.tokens.owner).post(`/staff/branches/${w.branchA._id}/advances`, { staffId: w.stylist1._id.toString(), amountPaise: 1000, date: '2026-12-01', recoveryPerMonthPaise: 500 });
    const leaves = await as(w.tokens.owner).get(`/staff/branches/${w.branchA._id}/leaves`);
    expect(leaves.status).toBe(200);
    expect(leaves.body[0].staffId).toMatchObject({ name: 'Sam Stylist', designation: 'stylist' });
    const advances = await as(w.tokens.owner).get(`/staff/branches/${w.branchA._id}/advances`);
    expect(advances.status).toBe(200);
    expect(advances.body[0].staffId.name).toBe('Sam Stylist');
  });
});
