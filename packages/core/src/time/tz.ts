/**
 * Time-zone utilities built on Intl, with no external dependencies.
 *
 * Morrow stores instants in UTC and evaluates calendar rules ("send at 09:00 on
 * the contact's birthday") in explicit IANA time zones. Local calendar dates are
 * represented as `YYYY-MM-DD` strings.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

const validityCache = new Map<string, boolean>();

export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) return false;
  const cached = validityCache.get(timeZone);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    ok = true;
  } catch {
    ok = false;
  }
  validityCache.set(timeZone, ok);
  return ok;
}

/** Wall-clock components of an instant in a time zone. */
export function zonedParts(instant: Date | number, timeZone: string): ZonedParts {
  const date = typeof instant === 'number' ? new Date(instant) : instant;
  const out: ZonedParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0, weekday: 0 };
  for (const part of formatter(timeZone).formatToParts(date)) {
    switch (part.type) {
      case 'year':
        out.year = Number(part.value);
        break;
      case 'month':
        out.month = Number(part.value);
        break;
      case 'day':
        out.day = Number(part.value);
        break;
      case 'hour':
        out.hour = Number(part.value) % 24;
        break;
      case 'minute':
        out.minute = Number(part.value);
        break;
      case 'second':
        out.second = Number(part.value);
        break;
      case 'weekday':
        out.weekday = WEEKDAYS[part.value] ?? 0;
        break;
      default:
        break;
    }
  }
  return out;
}

/** Offset of the time zone from UTC at the given instant, in minutes (IST = +330). */
export function tzOffsetMinutes(instant: Date | number, timeZone: string): number {
  const ms = typeof instant === 'number' ? instant : instant.getTime();
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = ms - (((ms % 1000) + 1000) % 1000);
  return Math.round((asUtc - truncated) / 60000);
}

function sameWallClock(p: ZonedParts, l: Required<LocalDateTime>): boolean {
  return p.year === l.year && p.month === l.month && p.day === l.day && p.hour === l.hour && p.minute === l.minute;
}

/**
 * Convert a wall-clock time in a zone to a UTC instant.
 *
 * - Ambiguous times (DST fall-back) resolve to the earlier instant.
 * - Non-existent times (DST spring-forward gap) shift forward, e.g. 02:30 → 03:30.
 */
export function zonedTimeToUtc(local: LocalDateTime, timeZone: string): Date {
  const l: Required<LocalDateTime> = { hour: 0, minute: 0, second: 0, ...local };
  const guess = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second);
  const o1 = tzOffsetMinutes(guess, timeZone);
  const c1 = guess - o1 * 60000;
  const o2 = tzOffsetMinutes(c1, timeZone);
  const c2 = guess - o2 * 60000;
  const candidates = [...new Set([c1, c2])].sort((a, b) => a - b);
  for (const c of candidates) {
    if (sameWallClock(zonedParts(c, timeZone), l)) return new Date(c);
  }
  // Inside a DST gap: no wall-clock match exists, move forward.
  return new Date(candidates[candidates.length - 1]!);
}

// ---------------------------------------------------------------------------
// Local calendar dates (YYYY-MM-DD)
// ---------------------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatLocalDate(p: DateParts): string {
  return `${String(p.year).padStart(4, '0')}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

export function parseLocalDate(value: string): DateParts | null {
  const m = DATE_RE.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function isValidLocalDate(value: unknown): value is string {
  return typeof value === 'string' && parseLocalDate(value) !== null;
}

function requireDate(value: string): DateParts {
  const p = parseLocalDate(value);
  if (!p) throw new RangeError(`Invalid local date: ${value}`);
  return p;
}

/** The calendar date of an instant in a time zone. */
export function localDate(instant: Date | number, timeZone: string): string {
  return formatLocalDate(zonedParts(instant, timeZone));
}

export function addDays(date: string, days: number): string {
  const p = requireDate(date);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return formatLocalDate({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  const pa = requireDate(a);
  const pb = requireDate(b);
  return Math.round((Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / 86_400_000);
}

export function compareLocalDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Day of week (0 = Sunday) for a local date. */
export function weekdayOf(date: string): number {
  const p = requireDate(date);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/** UTC instant of local midnight at the start of `date` in the zone. */
export function startOfLocalDay(date: string, timeZone: string): Date {
  const p = requireDate(date);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day }, timeZone);
}

/** Inclusive list of local dates from `from` to `to` (bounded to protect callers). */
export function dateRange(from: string, to: string, maxDays = 3660): string[] {
  const out: string[] = [];
  let cur = from;
  while (compareLocalDates(cur, to) <= 0 && out.length < maxDays) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Times of day (HH:MM)
// ---------------------------------------------------------------------------

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeOfDay(value: unknown): value is string {
  return typeof value === 'string' && TIME_RE.test(value);
}

export function parseTimeOfDay(value: string): { hour: number; minute: number } {
  const m = TIME_RE.exec(value);
  if (!m) throw new RangeError(`Invalid time of day: ${value}`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** The UTC instant of `time` on local `date` in the zone. */
export function localDateTimeToUtc(date: string, time: string, timeZone: string): Date {
  const d = requireDate(date);
  const t = parseTimeOfDay(time);
  return zonedTimeToUtc({ ...d, hour: t.hour, minute: t.minute }, timeZone);
}

/** Minutes since local midnight for an instant in a zone. */
export function localMinutesOfDay(instant: Date | number, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  return p.hour * 60 + p.minute;
}

/** A small list of common zones for pickers; any valid IANA zone is accepted. */
export const COMMON_TIME_ZONES = [
  'UTC',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Australia/Sydney',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Amsterdam',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Africa/Lagos',
  'Africa/Nairobi',
  'Pacific/Auckland',
] as const;

export function listTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    const all = intl.supportedValuesOf?.('timeZone');
    if (all && all.length) return all.includes('UTC') ? all : ['UTC', ...all];
  } catch {
    // fall through
  }
  return [...COMMON_TIME_ZONES];
}
