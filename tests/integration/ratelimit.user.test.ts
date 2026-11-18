// Low limits for this file only (the limiter reads them when the app loads)
process.env.API_RATE_LIMIT_PER_USER = '3';
process.env.API_RATE_LIMIT_PER_IP = '1000';
import '../helpers/testEnv';
import { useTestDb } from '../helpers/db';
import { as, seedWorld } from '../helpers/factory';

describe('I-03 rate limit per user (not per internet connection)', () => {
  useTestDb();

  it('one user hitting the limit does not block another user on the same IP', async () => {
    const w = await seedWorld();
    const owner: number[] = [];
    for (let i = 0; i < 4; i++) owner.push((await as(w.tokens.owner).get('/auth/me')).status);
    expect(owner.slice(0, 3)).toEqual([200, 200, 200]);
    expect(owner[3]).toBe(429);
    // Same machine (same IP), different person: still allowed
    expect((await as(w.tokens.manager).get('/auth/me')).status).toBe(200);
  });
});
