import '../helpers/testEnv';
import jwt from 'jsonwebtoken';
import { useTestDb } from '../helpers/db';
import { as, seedWorld, createPlatformAdmin, PASSWORD, tokenFor, World } from '../helpers/factory';
import { User, Business, Branch } from '../../src/models';
import { AuthService } from '../../src/services';

const login = (email: string, password = PASSWORD) => as().post('/auth/login', { email, password });

describe('Auth — login (Backend SRS §2, BR-09)', () => {
  useTestDb();
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('owner logs in with email + password and gets access + refresh tokens', async () => {
    const res = await login(w.owner.email);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user).toMatchObject({ role: 'owner', businessId: w.business._id.toString() });
  });

  it('email is trimmed and case-insensitive', async () => {
    const res = await login(`  ${w.owner.email.toUpperCase()}  `);
    expect(res.status).toBe(200);
  });

  it('never returns the password hash', async () => {
    const res = await login(w.owner.email);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
    const me = await as(res.body.accessToken).get('/auth/me');
    expect(JSON.stringify(me.body)).not.toMatch(/passwordHash/);
  });

  it('wrong password and unknown email return the same generic 401 (no account enumeration)', async () => {
    const wrong = await login(w.owner.email, 'Nope12345');
    const unknown = await login('nobody@salon.test', 'Nope12345');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.error).toEqual(wrong.body.error);
  });

  it('5 consecutive failures lock the account for 15 minutes, even for the right password', async () => {
    for (let i = 0; i < 5; i++) await login(w.manager.email, 'Wrong1234');
    const res = await login(w.manager.email);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
    const until = new Date(res.body.error.details.until).getTime();
    expect(until - Date.now()).toBeGreaterThan(14 * 60 * 1000);
    expect(until - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000);
  });

  it('lock expires after 15 minutes and a good login resets the counter', async () => {
    await User.updateOne(
      { _id: w.manager._id, businessId: w.business._id },
      { $set: { failedLogins: 5, lockedUntil: new Date(Date.now() - 1000) } }
    );
    const res = await login(w.manager.email);
    expect(res.status).toBe(200);
    const u = await User.findOne({ _id: w.manager._id, businessId: w.business._id });
    expect(u!.failedLogins).toBe(0);
  });

  it('a successful login resets the failure counter (4 fails + success + 4 fails = not locked)', async () => {
    for (let i = 0; i < 4; i++) await login(w.manager.email, 'Wrong1234');
    expect((await login(w.manager.email)).status).toBe(200);
    for (let i = 0; i < 4; i++) await login(w.manager.email, 'Wrong1234');
    expect((await login(w.manager.email)).status).toBe(200);
  });

  it('inactive user cannot log in (403 ACCOUNT_INACTIVE)', async () => {
    await User.updateOne({ _id: w.manager._id, businessId: w.business._id }, { $set: { status: 'inactive' } });
    const res = await login(w.manager.email);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_INACTIVE');
  });

  it('suspended business blocks all its logins', async () => {
    await Business.updateOne({ _id: w.business._id }, { $set: { status: 'suspended' } });
    const res = await login(w.owner.email);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_INACTIVE');
  });

  it('suspending a business also blocks already-issued access tokens', async () => {
    await Business.updateOne({ _id: w.business._id }, { $set: { status: 'suspended' } });
    const res = await as(w.tokens.owner).get('/customers');
    expect([401, 403]).toContain(res.status);
  });

  it('branch login of a deactivated branch cannot log in', async () => {
    await Branch.updateOne({ _id: w.branchA._id, businessId: w.business._id }, { $set: { status: 'deactivated' } });
    const res = await login(w.branchLoginA.email);
    expect(res.status).toBe(403);
  });

  it('deactivated branch login cannot keep using an existing access token', async () => {
    await Branch.updateOne({ _id: w.branchA._id, businessId: w.business._id }, { $set: { status: 'deactivated' } });
    const res = await as(w.tokens.branchA).get(`/branches/${w.branchA._id}/appointments`);
    expect([401, 403]).toContain(res.status);
  });

  it('refresh token should be an httpOnly cookie on /auth (Backend SRS §2 step 5)', async () => {
    const res = await login(w.owner.email);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] || []);
    expect(cookies.some((c) => /httponly/i.test(c) && /path=\/auth/i.test(c))).toBe(true);
  });
});
