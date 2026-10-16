/**
 * Recurring schedules expressed as wall-clock rules in a time zone
 * ("every Monday at 10:00 Asia/Kolkata"). Friendlier than cron for users and
 * DST-safe because every occurrence is resolved from local time.
 */
import { z } from 'zod';
import {
  addDays,
  compareLocalDates,
  daysInMonth,
  isValidLocalDate,
  isValidTimeOfDay,
  localDate,
  localDateTimeToUtc,
  parseLocalDate,
  weekdayOf,
} from './tz';

const timeOfDay = z.string().refine(isValidTimeOfDay, 'Use 24-hour HH:MM time.');
const date = z.string().refine(isValidLocalDate, 'Use a YYYY-MM-DD date.');

export const recurrenceSchema = z.discriminatedUnion('frequency', [
  z.object({ frequency: z.literal('once'), date, time: timeOfDay }),
  z.object({ frequency: z.literal('daily'), time: timeOfDay }),
  z.object({
    frequency: z.literal('weekly'),
    time: timeOfDay,
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  }),
  z.object({
    frequency: z.literal('monthly'),
    time: timeOfDay,
    /** 1-31; months without that day use their last day. */
    dayOfMonth: z.number().int().min(1).max(31),
  }),
]);

export type Recurrence = z.infer<typeof recurrenceSchema>;

function occursOnDate(rule: Recurrence, d: string): boolean {
  switch (rule.frequency) {
    case 'once':
      return rule.date === d;
    case 'daily':
      return true;
    case 'weekly':
      return rule.daysOfWeek.includes(weekdayOf(d));
    case 'monthly': {
      const p = parseLocalDate(d)!;
      return p.day === Math.min(rule.dayOfMonth, daysInMonth(p.year, p.month));
    }
  }
}

/**
 * Occurrences strictly after `after` and at or before `until`, oldest first.
 * Bounded by `limit` so a long downtime can never produce an unbounded burst.
 */
export function occurrencesBetween(
  rule: Recurrence,
  after: Date,
  until: Date,
  timeZone: string,
  limit = 366,
): Date[] {
  const out: Date[] = [];
  if (until.getTime() <= after.getTime()) return out;
  let d = addDays(localDate(after, timeZone), -1);
  const last = addDays(localDate(until, timeZone), 1);
  while (compareLocalDates(d, last) <= 0 && out.length < limit) {
    if (occursOnDate(rule, d)) {
      const at = localDateTimeToUtc(d, rule.time, timeZone);
      if (at.getTime() > after.getTime() && at.getTime() <= until.getTime()) out.push(at);
    }
    if (rule.frequency === 'once' && compareLocalDates(d, rule.date) >= 0) break;
    d = addDays(d, 1);
  }
  return out;
}

/** The first occurrence strictly after `after`, or null if the rule has ended. */
export function nextOccurrence(rule: Recurrence, after: Date, timeZone: string): Date | null {
  if (rule.frequency === 'once') {
    const at = localDateTimeToUtc(rule.date, rule.time, timeZone);
    return at.getTime() > after.getTime() ? at : null;
  }
  // 32 days always contains the next daily/weekly/monthly occurrence.
  const until = new Date(after.getTime() + 33 * 86_400_000);
  return occurrencesBetween(rule, after, until, timeZone, 1)[0] ?? null;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function describeRecurrence(rule: Recurrence): string {
  switch (rule.frequency) {
    case 'once':
      return `Once on ${rule.date} at ${rule.time}`;
    case 'daily':
      return `Every day at ${rule.time}`;
    case 'weekly':
      return `Every ${[...rule.daysOfWeek].sort().map((d) => DAY_NAMES[d]).join(', ')} at ${rule.time}`;
    case 'monthly':
      return `Monthly on day ${rule.dayOfMonth} at ${rule.time}`;
  }
}
