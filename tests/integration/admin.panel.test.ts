import '../helpers/testEnv';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, World, createPlatformAdmin, platformToken, address, PASSWORD } from '../helpers/factory';
import { Business, Branch, User, EmailRegistry, AuditLog } from '../../src/models';

const login = (email: string, password = PASSWORD) => as().post('/auth/login', { email, password });

const onboard = (suffix: string) => ({
  business: {
    name: `Salon ${suffix}`, address, gst: { enabled: false },
    discountLimits: {}, ownerWhatsappPhone: '9800000001',
  },
  owner: { name: 'Owner', email: `owner-${suffix}@salon.test`, password: 'Secret123' },
  headBranch: { name: 'Head', code: 'hq1', invoicePrefix: 'hq1', address, phone: '9800000002', loginEmail: `hq-${suffix}@salon.test`, loginPassword: 'Secret123' },
});

describe('Super Admin panel', () => {
  useTestDb();
  let w: World;
  let sa: string;
  beforeEach(async () => {
    w = await seedWorld();
    sa = platformToken(await createPlatformAdmin());
  });

  describe('onboarding', () => {
    it('writes userId + businessId into the email registry and returns no password hashes', async () => {
      const res = await as(sa).post('/admin/businesses', onboard('reg'));
      expect(res.status).toBe(201);
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');
      const reg = await EmailRegistry.findById('owner-reg@salon.test').lean();
      expect(reg).toMatchObject({ kind: 'tenant', userId: expect.anything(), businessId: expect.anything() });
      expect(String(reg!.businessId)).toBe(res.body.business._id);
    });

    it('a duplicate head-branch login email inside the transaction leaves nothing behind', async () => {
      // Registry has no entry for this email, so the pre-check passes; the users unique index rejects it mid-transaction.
      await User.syncIndexes();
      await User.create({ businessId: w.business._id, role: 'manager', name: 'x', email: 'clash@salon.test', passwordHash: 'x', branchIds: [] });
      const body = onboard('clash');
      body.headBranch.loginEmail = 'clash@salon.test';
      const res = await as(sa).post('/admin/businesses', body);
      expect(res.status).toBe(409);
      expect(await Business.countDocuments({ name: 'Salon clash' })).toBe(0);
      expect(await User.countDocuments({ email: 'owner-clash@salon.test' }, { skipTenantScope: true } as any)).toBe(0);
      expect(await EmailRegistry.countDocuments({ _id: 'owner-clash@salon.test' })).toBe(0);
    });

    it('a new branch login can log in and its registry entry is tied to the business', async () => {
      const res = await as(sa).post(`/admin/businesses/${w.business._id}/branches`, {
        name: 'Piplod', code: 'srt3', invoicePrefix: 'srt3', address, phone: '9800000003', loginEmail: 'piplod@salon.test', loginPassword: 'Secret123',
      });
      expect(res.status).toBe(201);
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');
      expect((await login('piplod@salon.test')).status).toBe(200);
      const reg = await EmailRegistry.findById('piplod@salon.test').lean();
      expect(String(reg!.businessId)).toBe(String(w.business._id));
      const audit = await AuditLog.findOne({ action: 'branch.create', businessId: w.business._id }, null, { skipTenantScope: true } as any);
      expect(audit).toBeTruthy();
    });
  });

  describe('GET /admin/stats', () => {
    it('returns platform counts', async () => {
      const res = await as(sa).get('/admin/stats');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        businesses: { total: 2, active: 2, suspended: 0 },
        branches: { total: 3, active: 3 },
        users: { owners: 2, managers: 1, branchLogins: 2 },
        pendingBranchRequests: 0,
      });
    });

    it('is super admin only', async () => {
      expect((await as(w.tokens.owner).get('/admin/stats')).status).toBe(403);
      expect((await as().get('/admin/stats')).status).toBe(401);
    });
  });

  describe('GET /admin/businesses', () => {
    it('lists businesses with owner and branch count, newest first', async () => {
      const res = await as(sa).get('/admin/businesses');
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.businesses).toHaveLength(2);
      const glam = res.body.businesses.find((b: any) => String(b._id) === String(w.business._id));
      expect(glam).toMatchObject({ name: w.business.name, status: 'active', branchCount: 2 });
      expect(glam.owner).toMatchObject({ email: w.owner.email, name: w.owner.name });
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    });

    it('supports q, status, page and limit', async () => {
      await Business.updateOne({ _id: w.otherBusiness._id }, { name: 'Other Hair Co', status: 'suspended' });
      const q = await as(sa).get('/admin/businesses?q=other');
      expect(q.body.businesses.map((b: any) => b.name)).toEqual(['Other Hair Co']);
      const s = await as(sa).get('/admin/businesses?status=active');
      expect(s.body.total).toBe(1);
      const p = await as(sa).get('/admin/businesses?page=2&limit=1');
      expect(p.body.total).toBe(2);
      expect(p.body.businesses).toHaveLength(1);
    });

    it('q is treated as text, not a regex', async () => {
      const res = await as(sa).get('/admin/businesses?q=.*');
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
    });

    it('rejects a bad status or limit', async () => {
      expect((await as(sa).get('/admin/businesses?status=deleted')).status).toBe(400);
      expect((await as(sa).get('/admin/businesses?limit=500')).status).toBe(400);
    });
  });

  describe('GET /admin/businesses/:id', () => {
    it('returns the business, its owner, branches and user counts', async () => {
      const res = await as(sa).get(`/admin/businesses/${w.business._id}`);
      expect(res.status).toBe(200);
      expect(res.body.business._id).toBe(String(w.business._id));
      expect(res.body.owner.email).toBe(w.owner.email);
      expect(res.body.branches.map((b: any) => b.code).sort()).toEqual(['SRT1', 'SRT2']);
      expect(res.body.counts).toEqual({ managers: 1, branchLogins: 2 });
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    });

    it('404 for an unknown id, 400 for a malformed one', async () => {
      expect((await as(sa).get('/admin/businesses/64b000000000000000000000')).status).toBe(404);
      expect((await as(sa).get('/admin/businesses/nope')).status).toBe(400);
    });
  });

  describe('PATCH /admin/businesses/:id', () => {
    it('suspending a business blocks its logins and revokes live sessions; reactivating restores login', async () => {
      const live = await login(w.owner.email);
      const res = await as(sa).patch(`/admin/businesses/${w.business._id}`, { status: 'suspended' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('suspended');
      expect((await as(live.body.accessToken).get('/auth/me')).status).toBe(401);
      expect((await login(w.owner.email)).status).toBe(403);
      await as(sa).patch(`/admin/businesses/${w.business._id}`, { status: 'active' });
      expect((await login(w.owner.email)).status).toBe(200);
    });

    it('audit entry is recorded against the business', async () => {
      await as(sa).patch(`/admin/businesses/${w.business._id}`, { name: 'Renamed' });
      const audit = await AuditLog.findOne({ action: 'business.update', businessId: w.business._id }, null, { skipTenantScope: true } as any);
      expect(audit).toBeTruthy();
    });
  });

  describe('POST /admin/branch-requests/:id/decide', () => {
    const raiseAdd = async () =>
      (await as(w.tokens.owner).post('/business/branch-requests', { type: 'add', payload: { name: 'City Light', address }, reason: 'Expansion' })).body;

    it('only "approve" or "reject" is accepted', async () => {
      const req = await raiseAdd();
      expect((await as(sa).post(`/admin/branch-requests/${req._id}/decide`, { decision: 'aprove' })).status).toBe(400);
      expect((await as(sa).get('/admin/branch-requests')).body).toHaveLength(1);
    });

    it('approving an add request without branch details is a 400, not a 500', async () => {
      const req = await raiseAdd();
      const res = await as(sa).post(`/admin/branch-requests/${req._id}/decide`, { decision: 'approve' });
      expect(res.status).toBe(400);
      expect(res.body.error.fields).toHaveProperty(['note.code']);
    });

    it('approving an add request creates the branch and its login', async () => {
      const req = await raiseAdd();
      const res = await as(sa).post(`/admin/branch-requests/${req._id}/decide`, {
        decision: 'approve',
        note: { code: 'srt3', invoicePrefix: 'srt3', phone: '9800000020', loginEmail: 'citylight@salon.test', loginPassword: 'Secret123' },
      });
      expect(res.status).toBe(200);
      expect(res.body.request.status).toBe('approved');
      expect(res.body.branch).toMatchObject({ name: 'City Light', code: 'SRT3' });
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');
      expect((await login('citylight@salon.test')).status).toBe(200);
    });

    it('rejecting stores the reason', async () => {
      const req = await raiseAdd();
      const res = await as(sa).post(`/admin/branch-requests/${req._id}/decide`, { decision: 'reject', note: { reason: 'Call us first' } });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'rejected', rejectReason: 'Call us first' });
    });
  });

  describe('GET /admin/audit-logs', () => {
    it('filters by businessId', async () => {
      await as(sa).patch(`/admin/businesses/${w.business._id}`, { name: 'Renamed' });
      await as(sa).patch(`/admin/businesses/${w.otherBusiness._id}`, { name: 'Renamed too' });
      const res = await as(sa).get(`/admin/audit-logs?businessId=${w.business._id}`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.logs[0].businessId).toBe(String(w.business._id));
      expect((await as(sa).get('/admin/audit-logs?businessId=nope')).status).toBe(400);
    });
  });

  describe('GET /admin/businesses/:id/users', () => {
    it('lists owner, managers and branch logins without password hashes', async () => {
      const res = await as(sa).get(`/admin/businesses/${w.business._id}/users`);
      expect(res.status).toBe(200);
      expect(res.body.map((u: any) => u.role).sort()).toEqual(['branch', 'branch', 'manager', 'owner']);
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    });

    it('filters by role', async () => {
      const res = await as(sa).get(`/admin/businesses/${w.business._id}/users?role=branch`);
      expect(res.body).toHaveLength(2);
    });
  });

  describe('POST /admin/users/:id/password', () => {
    it('resets a tenant password, revokes sessions and returns 204', async () => {
      const live = await login(w.manager.email);
      const res = await as(sa).post(`/admin/users/${w.manager._id}/password`, { password: 'NewPass123' });
      expect(res.status).toBe(204);
      expect((await as(live.body.accessToken).get('/auth/me')).status).toBe(401);
      expect((await login(w.manager.email)).status).toBe(401);
      expect((await login(w.manager.email, 'NewPass123')).status).toBe(200);
    }, 30000);

    it('enforces password rules and 404s an unknown user', async () => {
      expect((await as(sa).post(`/admin/users/${w.manager._id}/password`, { password: 'short' })).status).toBe(400);
      expect((await as(sa).post(`/admin/users/${w.manager._id}/password`, { password: 'lettersonly' })).status).toBe(400);
      expect((await as(sa).post('/admin/users/64b000000000000000000000/password', { password: 'NewPass123' })).status).toBe(404);
    });

    it('owner cannot use it', async () => {
      expect((await as(w.tokens.owner).post(`/admin/users/${w.manager._id}/password`, { password: 'NewPass123' })).status).toBe(403);
    });
  });

  describe('POST /admin/users/:id/status', () => {
    it('deactivating a user blocks login and revokes sessions; reactivating restores it', async () => {
      const live = await login(w.manager.email);
      const off = await as(sa).post(`/admin/users/${w.manager._id}/status`, { status: 'inactive' });
      expect(off.status).toBe(200);
      expect(off.body.status).toBe('inactive');
      expect(off.body.passwordHash).toBeUndefined();
      expect((await as(live.body.accessToken).get('/auth/me')).status).toBe(401);
      expect((await login(w.manager.email)).status).toBe(403);
      await as(sa).post(`/admin/users/${w.manager._id}/status`, { status: 'active' });
      expect((await login(w.manager.email)).status).toBe(200);
    });

    it('rejects an unknown status', async () => {
      expect((await as(sa).post(`/admin/users/${w.manager._id}/status`, { status: 'banned' })).status).toBe(400);
    });

    it('cannot reactivate the login of a deactivated branch', async () => {
      await Branch.updateOne({ _id: w.branchB._id }, { status: 'deactivated' }, { skipTenantScope: true } as any);
      const res = await as(sa).post(`/admin/users/${w.branchLoginB._id}/status`, { status: 'active' });
      expect(res.status).toBe(409);
    });
  });
});
