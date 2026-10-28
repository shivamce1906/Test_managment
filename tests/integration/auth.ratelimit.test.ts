import '../helpers/testEnv';
import { useTestDb } from '../helpers/db';
import { as } from '../helpers/factory';

// Separate file: rate-limit counters are per process and would disturb other auth tests.
describe('Auth — login rate limit (Backend SRS §12: 5 attempts / min / IP)', () => {
  useTestDb();

  it('6th login attempt within a minute from one IP is rejected with 429 RATE_LIMITED', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await as().post('/auth/login', { email: `x${i}@salon.test`, password: 'Wrong1234' });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});
