import {
  getBusinessDate,
  getFinancialYear,
  getBusinessMonth,
  isOverlapping,
  parseIstDateTime,
  formatIstTime,
  getIstDayOfWeek,
  getDaysInMonth,
} from '../../src/utils/dates';

describe('date utils (IST business dates)', () => {
  describe('getBusinessDate', () => {
    it('uses IST, not UTC: 23:59 IST is still the same day', () => {
      expect(getBusinessDate(new Date('2026-10-27T18:29:59.999Z'))).toBe('2026-10-27');
    });
    it('rolls to the next day at IST midnight (18:30 UTC)', () => {
      expect(getBusinessDate(new Date('2026-10-27T18:30:00.000Z'))).toBe('2026-10-28');
    });
    it('handles year end', () => {
      expect(getBusinessDate(new Date('2026-12-31T18:30:00.000Z'))).toBe('2027-01-01');
    });
    it('handles leap day', () => {
      expect(getBusinessDate(new Date('2028-02-29T06:00:00.000Z'))).toBe('2028-02-29');
    });
  });

  describe('getFinancialYear (April start)', () => {
    it('April 1 IST starts the new FY', () => {
      expect(getFinancialYear(new Date('2026-03-31T18:30:00.000Z'))).toBe('2026-27');
    });
    it('March 31 23:59 IST is still the old FY', () => {
      expect(getFinancialYear(new Date('2026-03-31T18:29:59.000Z'))).toBe('2025-26');
    });
    it('January belongs to the FY that started previous April', () => {
      expect(getFinancialYear(new Date('2027-01-15T06:00:00.000Z'))).toBe('2026-27');
    });
    it('formats century rollover as 2 digits', () => {
      expect(getFinancialYear(new Date('2099-06-01T06:00:00.000Z'))).toBe('2099-00');
    });
    it('respects a custom fyStartMonth', () => {
      expect(getFinancialYear(new Date('2026-06-01T06:00:00.000Z'), 7)).toBe('2025-26');
      expect(getFinancialYear(new Date('2026-07-01T06:00:00.000Z'), 7)).toBe('2026-27');
    });
  });

  describe('getBusinessMonth', () => {
    it('uses IST month boundary', () => {
      expect(getBusinessMonth(new Date('2026-10-31T18:30:00.000Z'))).toBe('2026-11');
      expect(getBusinessMonth(new Date('2026-10-31T18:29:00.000Z'))).toBe('2026-10');
    });
  });

  describe('isOverlapping (slot clash maths)', () => {
    const t = (hh: string) => new Date(`2026-10-27T${hh}:00.000Z`);
    it('detects partial overlap', () => {
      expect(isOverlapping(t('10:00'), t('11:00'), t('10:30'), t('11:30'))).toBe(true);
    });
    it('detects containment', () => {
      expect(isOverlapping(t('10:00'), t('12:00'), t('10:30'), t('11:00'))).toBe(true);
    });
    it('back-to-back slots do NOT overlap', () => {
      expect(isOverlapping(t('10:00'), t('11:00'), t('11:00'), t('12:00'))).toBe(false);
    });
    it('identical slots overlap', () => {
      expect(isOverlapping(t('10:00'), t('11:00'), t('10:00'), t('11:00'))).toBe(true);
    });
  });

  describe('IST parsing and formatting', () => {
    it('parses 10:00 IST as 04:30 UTC', () => {
      expect(parseIstDateTime('2026-10-27', '10:00').toISOString()).toBe('2026-10-27T04:30:00.000Z');
    });
    it('round-trips HH:mm', () => {
      expect(formatIstTime(parseIstDateTime('2026-10-27', '19:45'))).toBe('19:45');
    });
    it('parses 00:15 IST onto the previous UTC day', () => {
      expect(parseIstDateTime('2026-10-27', '00:15').toISOString()).toBe('2026-10-26T18:45:00.000Z');
    });
    it('day of week follows IST', () => {
      // 2026-10-25 is a Sunday; 20:00 UTC Saturday = 01:30 IST Sunday
      expect(getIstDayOfWeek(new Date('2026-10-24T20:00:00.000Z'))).toBe(0);
    });
  });

  describe('getDaysInMonth', () => {
    it('knows leap and non-leap February', () => {
      expect(getDaysInMonth('2028-02')).toBe(29);
      expect(getDaysInMonth('2026-02')).toBe(28);
      expect(getDaysInMonth(2026, 10)).toBe(31);
    });
  });
});
