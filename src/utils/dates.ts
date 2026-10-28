/**
 * Date and time utilities.
 * All business operations in Glox Salon operate in Indian Standard Time (IST: UTC+05:30).
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Returns the IST calendar date as YYYY-MM-DD string.
 */
export function getBusinessDate(date: Date = new Date()): string {
  const istDate = new Date(date.getTime() + IST_OFFSET_MS);
  const year = istDate.getUTCFullYear();
  const month = String(istDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(istDate.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Returns financial year string, e.g. '2026-27' for April 2026 to March 2027.
 * fyStartMonth is 1-indexed (default 4 for April).
 */
export function getFinancialYear(date: Date = new Date(), fyStartMonth: number = 4): string {
  const istDate = new Date(date.getTime() + IST_OFFSET_MS);
  const year = istDate.getUTCFullYear();
  const month = istDate.getUTCMonth() + 1; // 1-12

  let startYear = year;
  if (month < fyStartMonth) {
    startYear = year - 1;
  }
  const endYearShort = String((startYear + 1) % 100).padStart(2, '0');
  return `${startYear}-${endYearShort}`;
}

/**
 * Returns the month string as YYYY-MM in IST.
 */
export function getBusinessMonth(date: Date = new Date()): string {
  const istDate = new Date(date.getTime() + IST_OFFSET_MS);
  const year = istDate.getUTCFullYear();
  const month = String(istDate.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Checks if two time windows overlap: startA < endB && endA > startB.
 */
export function isOverlapping(startA: Date, endA: Date, startB: Date, endB: Date): boolean {
  return startA.getTime() < endB.getTime() && endA.getTime() > startB.getTime();
}

/**
 * Parse a 'HH:mm' string and a businessDate 'YYYY-MM-DD' into a UTC Date object in IST.
 */
export function parseIstDateTime(businessDate: string, timeStr: string): Date {
  const [year, month, day] = businessDate.split('-').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);
  // Create UTC date that equals IST time
  // IST is UTC + 5h30m, so UTC = IST - 5h30m
  const utcMs = Date.UTC(year, month - 1, day, hour, minute) - IST_OFFSET_MS;
  return new Date(utcMs);
}

/**
 * Formats a UTC Date to 'HH:mm' in IST.
 */
export function formatIstTime(date: Date): string {
  const istDate = new Date(date.getTime() + IST_OFFSET_MS);
  const hours = String(istDate.getUTCHours()).padStart(2, '0');
  const minutes = String(istDate.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Returns day of week 0-6 (0=Sunday, 6=Saturday) in IST.
 */
export function getIstDayOfWeek(date: Date = new Date()): number {
  const istDate = new Date(date.getTime() + IST_OFFSET_MS);
  return istDate.getUTCDay();
}

/**
 * Returns number of days in a month ('YYYY-MM' or year, month).
 */
export function getDaysInMonth(yearOrYearMonth: string | number, monthNum?: number): number {
  if (typeof yearOrYearMonth === 'string') {
    const [year, month] = yearOrYearMonth.split('-').map(Number);
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }
  return new Date(Date.UTC(yearOrYearMonth, monthNum!, 0)).getUTCDate();
}
