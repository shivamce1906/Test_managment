import '../helpers/testEnv';
import { maskPhone, maskEmail, normalizePhone } from '../../src/utils/masking';
import { encryptData, decryptData, hashPassword, verifyPassword, generateRandomToken } from '../../src/utils/crypto';

describe('phone masking (PRD §3: "98XXXXXX21")', () => {
  it('masks +91 numbers to first2 + XXXXXX + last2', () => {
    expect(maskPhone('+919876543221')).toBe('98XXXXXX21');
  });
  it('masks bare 10-digit numbers', () => {
    expect(maskPhone('9876543221')).toBe('98XXXXXX21');
  });
  it('never leaks digits for short/invalid input', () => {
    expect(maskPhone('12345')).toBe('XXXXXXXXXX');
    expect(maskPhone('')).toBe('');
    expect(maskPhone(undefined)).toBe('');
  });
  it('masks formatted numbers', () => {
    expect(maskPhone('+91 98765-43221')).toBe('98XXXXXX21');
  });
});

describe('email masking', () => {
  it('keeps first/last char of local part', () => {
    expect(maskEmail('priya@gmail.com')).toBe('p***a@gmail.com');
  });
  it('fully masks very short local parts', () => {
    expect(maskEmail('ab@x.com')).toBe('*@x.com');
  });
  it('returns empty for invalid input', () => {
    expect(maskEmail('not-an-email')).toBe('');
  });
});

describe('normalizePhone (+91XXXXXXXXXX)', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['+91 98765 43210', '+919876543210'],
    ['98765-43210', '+919876543210'],
  ])('%s -> %s', (input, out) => {
    expect(normalizePhone(input)).toBe(out);
  });
  it('EDGE: garbage input must not produce a stored "valid-looking" number', () => {
    // A 5-digit or letters-only input should not normalise into a +91 identity: either rejected
    // (the API then answers 400) or at least not shaped like a phone.
    const attempt = (raw: string) => { try { return normalizePhone(raw); } catch { return null; } };
    expect(attempt('12345') ?? '').not.toMatch(/^\+\d{1,9}$/);
    expect(attempt('abcdefghij')).not.toBe('+');
    expect(() => normalizePhone('12345')).toThrow();
  });
});

describe('AES-256-GCM encryption (AiSensy keys)', () => {
  it('round-trips', () => {
    expect(decryptData(encryptData('aisensy-key-123'))).toBe('aisensy-key-123');
  });
  it('uses a random IV (same plaintext -> different ciphertext)', () => {
    expect(encryptData('x')).not.toBe(encryptData('x'));
  });
  it('detects tampering', () => {
    const enc = Buffer.from(encryptData('secret'), 'base64');
    enc[enc.length - 1] ^= 0xff;
    expect(() => decryptData(enc.toString('base64'))).toThrow();
  });
  it('rejects truncated input', () => {
    expect(() => decryptData('YWJj')).toThrow();
  });
  it('handles unicode', () => {
    expect(decryptData(encryptData('₹ नमस्ते 🙂'))).toBe('₹ नमस्ते 🙂');
  });
});

describe('password hashing', () => {
  it('verifies correct and rejects wrong password', async () => {
    const h = await hashPassword('Secret123');
    expect(h).not.toContain('Secret123');
    expect(await verifyPassword('Secret123', h)).toBe(true);
    expect(await verifyPassword('secret123', h)).toBe(false);
  }, 20000);
  it('uses bcrypt cost 12 (Backend SRS §2)', async () => {
    const h = await hashPassword('x');
    expect(h.startsWith('$2b$12$')).toBe(true);
  }, 20000);
  it('random tokens are unique hex of requested length', () => {
    const a = generateRandomToken(16);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(generateRandomToken(16));
  });
});
