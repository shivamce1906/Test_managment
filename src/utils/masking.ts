import { AppError } from './errors';

/**
 * Masking utilities for phone numbers and email addresses per FR-AUTH-09.
 * Masks Indian 10-digit / +91 phone numbers to format '98XXXXXX21'.
 */

export function maskPhone(phone?: string): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return 'XXXXXXXXXX';
  const core10 = digits.slice(-10);
  const first2 = core10.slice(0, 2);
  const last2 = core10.slice(-2);
  return `${first2}XXXXXX${last2}`;
}

export function maskEmail(email?: string): string {
  if (!email || !email.includes('@')) return '';
  const [local, domain] = email.split('@');
  if (local.length <= 2) {
    return `*@${domain}`;
  }
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

/**
 * Normalises phone numbers to standard E.164 +91XXXXXXXXXX format.
 */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) {
    return `+91${digits}`;
  }
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('0')) {
    return `+91${digits.slice(1)}`;
  }
  // Other countries: E.164 allows up to 15 digits. Anything shorter than 10 is not a phone.
  if (digits.length >= 11 && digits.length <= 15) {
    return `+${digits}`;
  }
  throw new AppError(400, 'VALIDATION_ERROR', 'Invalid phone number', { fields: { phone: 'Enter a valid 10-digit mobile number' } });
}
