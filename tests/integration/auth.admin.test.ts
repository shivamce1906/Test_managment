import '../helpers/testEnv';
import jwt from 'jsonwebtoken';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, createPlatformAdmin, PASSWORD, tokenFor, World } from '../helpers/factory';
import { User, Business, Branch } from '../../src/models';
import { AuthService } from '../../src/services';

const login = (email: string, password = PASSWORD) => as().post('/auth/login', { email, password });

describe('Auth — Super Admin and password management', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('super admin logs in as a platform user and can reach /admin', async () => {
    const admin = await createPlatformAdmin();
    const l = await login(admin.email);
    expect(l.status).toBe(200);
    expect(l.body.user.kind).toBe('platform');
    const res = await as(l.body.accessToken).get('/admin/branch-requests');
    expect(res.status).toBe(200);
  });

  it('salon owner cannot reach /admin', async () => {
    const res = await as(w.tokens.owner).get('/admin/branch-requests');
    expect(res.status).toBe(403);
  });

  it('platform token cannot use tenant routes (requireKind tenant)', async () => {
    const admin = await createPlatformAdmin();
    const l = await login(admin.email);
    const res = await as(l.body.accessToken).get('/customers');
    expect(res.status).toBe(403);
  });

  it('owner can set a manager password: POST /business/users/:id/password (Backend SRS §2)', async () => {
    const res = await as(w.tokens.owner).post(`/business/users/${w.manager._id}/password`, { password: 'NewPass123' });
    expect([200, 204]).toContain(res.status);
  });

  it('super admin can reset any password: POST /admin/users/:id/password', async () => {
    const admin = await createPlatformAdmin();
    const l = await login(admin.email);
    const res = await as(l.body.accessToken).post(`/admin/users/${w.owner._id}/password`, { password: 'NewPass123' });
    expect([200, 204]).toContain(res.status);
  });

  it('AuthService.setPassword works for the super admin context the middleware actually builds', async () => {
    const admin = await createPlatformAdmin();
    const ctx: any = { userId: admin._id.toString(), role: 'super_admin', kind: 'platform', name: 'a', branchIds: [] };
    await expect(new AuthService().setPassword(ctx, w.owner._id.toString(), 'NewPass123')).resolves.toBeUndefined();
  }, 20000);

  it('owner password reset of a manager revokes the manager\'s sessions', async () => {
    const ctx: any = { userId: w.owner._id.toString(), businessId: w.business._id.toString(), role: 'owner', kind: 'tenant', name: 'o', branchIds: [] };
    const l = await login(w.manager.email);
    await new AuthService().setPassword(ctx, w.manager._id.toString(), 'NewPass123');
    expect((await as(l.body.accessToken).get('/auth/me')).status).toBe(401);
    expect((await login(w.manager.email, 'NewPass123')).status).toBe(200);
  }, 30000);

  it('owner cannot set the password of a user in another business', async () => {
    const ctx: any = { userId: w.owner._id.toString(), businessId: w.business._id.toString(), role: 'owner', kind: 'tenant', name: 'o', branchIds: [] };
    await expect(new AuthService().setPassword(ctx, w.otherOwner._id.toString(), 'NewPass123')).rejects.toMatchObject({ statusCode: 404 });
  }, 20000);

  it('unused helper sanity: tokenFor works for other tenant', async () => {
    expect((await as(tokenFor(w.otherOwner)).get('/auth/me')).status).toBe(200);
  });
});
