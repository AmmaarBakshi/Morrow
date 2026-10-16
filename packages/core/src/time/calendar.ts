/**
 * Calendar occasions: birthdays, work anniversaries and other yearly dates.
 *
 * A yearly occasion is a month + day (a birthday does not need a birth year).
 * 29 February occasions need an explicit policy for non-leap years.
 */
import { addDays, daysBetween, formatLocalDate, isLeapYear, parseLocalDate } from './tz';

export const LEAP_DAY_POLICIES = ['feb28', 'mar1', 'skip'] as const;
export type LeapDayPolicy = (typeof LEAP_DAY_POLICIES)[number];

export const LEAP_DAY_POLICY_LABELS: Record<LeapDayPolicy, string> = {
  feb28: 'Celebrate on 28 February in non-leap years',
  mar1: 'Celebrate on 1 March in non-leap years',
  skip: 'Only celebrate in leap years',
};

export interface MonthDay {
  month: number;
  day: number;
}

/** True for any real calendar day, including 29 February. */
export function isValidMonthDay(month: unknown, day: unknown): boolean {
  if (!Number.isInteger(month) || !Number.isInteger(day)) return false;
  const m = month as number;
  const d = day as number;
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
}

/** Compact integer form used for indexing: 7 March → 307. */
export function monthDayKey(md: MonthDay): number {
  return md.month * 100 + md.day;
}

export function fromMonthDayKey(key: number): MonthDay {
  return { month: Math.floor(key / 100), day: key % 100 };
}

/**
 * Which month/day occasions are celebrated on a given local date.
 * In a non-leap year, 29 February occasions are celebrated on 28 February or
 * 1 March depending on the policy (or not at all).
 */
export function occasionsCelebratedOn(date: string, policy: LeapDayPolicy): MonthDay[] {
  const p = parseLocalDate(date);
  if (!p) throw new RangeError(`Invalid local date: ${date}`);
  const list: MonthDay[] = [{ month: p.month, day: p.day }];
  if (!isLeapYear(p.year)) {
    if (policy === 'feb28' && p.month === 2 && p.day === 28) list.push({ month: 2, day: 29 });
    if (policy === 'mar1' && p.month === 3 && p.day === 1) list.push({ month: 2, day: 29 });
  }
  return list;
}

/** The local date an occasion is celebrated in a given year, or null when skipped. */
export function celebrationDate(md: MonthDay, year: number, policy: LeapDayPolicy): string | null {
  if (md.month === 2 && md.day === 29 && !isLeapYear(year)) {
    if (policy === 'feb28') return formatLocalDate({ year, month: 2, day: 28 });
    if (policy === 'mar1') return formatLocalDate({ year, month: 3, day: 1 });
    return null;
  }
  return formatLocalDate({ year, month: md.month, day: md.day });
}

/** The next celebration on or after `fromDate` (searches up to 8 years for leap-only policies). */
export function nextCelebration(md: MonthDay, fromDate: string, policy: LeapDayPolicy): string | null {
  const from = parseLocalDate(fromDate);
  if (!from) throw new RangeError(`Invalid local date: ${fromDate}`);
  for (let year = from.year; year <= from.year + 8; year++) {
    const d = celebrationDate(md, year, policy);
    if (d && d >= fromDate) return d;
  }
  return null;
}

/** Days until the next celebration (0 = today). */
export function daysUntilCelebration(md: MonthDay, fromDate: string, policy: LeapDayPolicy): number | null {
  const next = nextCelebration(md, fromDate, policy);
  return next ? daysBetween(fromDate, next) : null;
}

/** All month/day keys celebrated in the inclusive window [fromDate, fromDate + days). */
export function occasionKeysInWindow(fromDate: string, days: number, policy: LeapDayPolicy): number[] {
  const keys = new Set<number>();
  for (let i = 0; i < days; i++) {
    for (const md of occasionsCelebratedOn(addDays(fromDate, i), policy)) keys.add(monthDayKey(md));
  }
  return [...keys];
}

/**
 * Completed years between a start date (e.g. hire date) and a local date.
 * Used for "3 years with us" style anniversaries.
 */
export function completedYears(startDate: string, onDate: string): number {
  const s = parseLocalDate(startDate);
  const o = parseLocalDate(onDate);
  if (!s || !o) throw new RangeError('Invalid local date');
  let years = o.year - s.year;
  if (o.month < s.month || (o.month === s.month && o.day < s.day)) years -= 1;
  return Math.max(0, years);
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function monthName(month: number): string {
  return MONTH_NAMES[month - 1] ?? '';
}

export function formatMonthDay(md: MonthDay): string {
  return `${md.day} ${monthName(md.month)}`;
}
