import '../helpers/testEnv';
import jwt from 'jsonwebtoken';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, createPlatformAdmin, PASSWORD, tokenFor, World } from '../helpers/factory';
import { User, Business, Branch } from '../../src/models';
import { AuthService } from '../../src/services';

const login = (email: string, password = PASSWORD) => as().post('/auth/login', { email, password });

describe('Auth — tokens and sessions', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('missing token -> 401 UNAUTHENTICATED', async () => {
    const res = await as().get('/customers');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('tampered token -> 401', async () => {
    const t = w.tokens.owner;
    const res = await as(t.slice(0, -3) + (t.endsWith('a') ? 'bbb' : 'aaa')).get('/customers');
    expect(res.status).toBe(401);
  });

  it('token signed with another secret -> 401', async () => {
    const forged = jwt.sign({ sub: w.owner._id.toString(), kind: 'tenant', role: 'owner', sv: 0 }, 'attacker-secret');
    const res = await as(forged).get('/customers');
    expect(res.status).toBe(401);
  });

  it('expired access token -> 401', async () => {
    const expired = jwt.sign(
      { sub: w.owner._id.toString(), kind: 'tenant', role: 'owner', sv: 0, exp: Math.floor(Date.now() / 1000) - 60 },
      process.env.JWT_SECRET!
    );
    const res = await as(expired).get('/customers');
    expect(res.status).toBe(401);
  });

  it('role claim in the token cannot escalate privileges (role read from DB)', async () => {
    const t = new AuthService().generateAccessToken({
      sub: w.branchLoginA._id.toString(), kind: 'tenant', role: 'owner', businessId: w.business._id.toString(), sv: 0,
    });
    const res = await as(t).post(`/bills/000000000000000000000000/cancel`, { reason: 'x' });
    expect(res.status).toBe(403);
  });

  it('refresh rotates: new pair issued, old refresh token can no longer be used', async () => {
    const l = await login(w.owner.email);
    const r1 = await as().post('/auth/refresh', { refreshToken: l.body.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.accessToken).toBeTruthy();
    const newRefresh = r1.body.newRefreshToken || r1.body.refreshToken;
    expect(newRefresh).toBeTruthy();
    expect(newRefresh).not.toBe(l.body.refreshToken);
  });

  it('refresh response uses the documented field name `refreshToken`', async () => {
    const l = await login(w.owner.email);
    const r1 = await as().post('/auth/refresh', { refreshToken: l.body.refreshToken });
    expect(r1.body.refreshToken).toBeTruthy();
  });

  it('reusing an old refresh token revokes the whole session family', async () => {
    const l = await login(w.owner.email);
    const r1 = await as().post('/auth/refresh', { refreshToken: l.body.refreshToken });
    const rotated = r1.body.newRefreshToken || r1.body.refreshToken;

    const reuse = await as().post('/auth/refresh', { refreshToken: l.body.refreshToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('SESSION_REVOKED');

    // The legitimately rotated token and the latest access token are now dead too
    const r2 = await as().post('/auth/refresh', { refreshToken: rotated });
    expect(r2.status).toBe(401);
    const me = await as(r1.body.accessToken).get('/auth/me');
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('SESSION_REVOKED');
  });

  it('SECURITY: a forged refresh token naming another user must NOT log that user out', async () => {
    const victim = await login(w.owner.email);
    const forged = `${w.owner._id.toString()}.deadbeefdeadbeefdeadbeefdeadbeef.whatever`;
    await as().post('/auth/refresh', { refreshToken: forged });
    const me = await as(victim.body.accessToken).get('/auth/me');
    expect(me.status).toBe(200);
  });

  it('malformed refresh token -> 401', async () => {
    const res = await as().post('/auth/refresh', { refreshToken: 'garbage' });
    expect(res.status).toBe(401);
  });

  it('logout kills the refresh token', async () => {
    const l = await login(w.owner.email);
    await as(l.body.accessToken).post('/auth/logout', { refreshToken: l.body.refreshToken });
    const r = await as().post('/auth/refresh', { refreshToken: l.body.refreshToken });
    expect(r.status).toBe(401);
  });

  it('deactivating a manager revokes their live access token', async () => {
    const l = await login(w.manager.email);
    const up = await as(w.tokens.owner).patch(`/business/managers/${w.manager._id}`, { status: 'inactive' });
    expect(up.status).toBe(200);
    const res = await as(l.body.accessToken).get('/auth/me');
    expect(res.status).toBe(401);
  });

  it('changing a manager\'s branches revokes their session (SESSION_REVOKED)', async () => {
    const l = await login(w.manager.email);
    await as(w.tokens.owner).patch(`/business/managers/${w.manager._id}`, { branchIds: [w.branchB._id.toString()] });
    const res = await as(l.body.accessToken).get('/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_REVOKED');
  });

  it('/auth/me returns user context', async () => {
    const res = await as(w.tokens.manager).get('/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ role: 'manager', branchIds: [w.branchA._id.toString()] });
  });
});
