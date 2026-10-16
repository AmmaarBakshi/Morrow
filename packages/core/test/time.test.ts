import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysBetween,
  isValidTimeZone,
  localDate,
  localDateTimeToUtc,
  parseLocalDate,
  startOfLocalDay,
  tzOffsetMinutes,
  weekdayOf,
  zonedParts,
  zonedTimeToUtc,
} from '../src/time/tz';
import {
  celebrationDate,
  completedYears,
  nextCelebration,
  occasionKeysInWindow,
  occasionsCelebratedOn,
  ordinal,
} from '../src/time/calendar';
import { describeRecurrence, nextOccurrence, occurrencesBetween } from '../src/time/recurrence';

describe('time zones', () => {
  it('validates IANA zone names', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });

  it('computes half-hour offsets (IST is UTC+05:30)', () => {
    expect(tzOffsetMinutes(new Date('2026-03-07T00:00:00Z'), 'Asia/Kolkata')).toBe(330);
    expect(tzOffsetMinutes(new Date('2026-03-07T00:00:00Z'), 'Asia/Kathmandu')).toBe(345);
  });

  it('resolves the local date of an instant near midnight', () => {
    // 18:29 UTC on 6 March is 23:59 IST on 6 March; 18:30 UTC is 00:00 IST on 7 March.
    expect(localDate(new Date('2026-03-06T18:29:00Z'), 'Asia/Kolkata')).toBe('2026-03-06');
    expect(localDate(new Date('2026-03-06T18:30:00Z'), 'Asia/Kolkata')).toBe('2026-03-07');
    // The same instant is still 6 March in New York.
    expect(localDate(new Date('2026-03-06T18:30:00Z'), 'America/New_York')).toBe('2026-03-06');
  });

  it('handles date-line extremes', () => {
    const instant = new Date('2026-03-07T11:00:00Z');
    expect(localDate(instant, 'Pacific/Kiritimati')).toBe('2026-03-08'); // UTC+14
    expect(localDate(instant, 'Pacific/Pago_Pago')).toBe('2026-03-07'); // UTC-11
  });

  it('converts local wall-clock time to UTC', () => {
    expect(zonedTimeToUtc({ year: 2026, month: 3, day: 7, hour: 9 }, 'Asia/Kolkata').toISOString()).toBe(
      '2026-03-07T03:30:00.000Z',
    );
    expect(localDateTimeToUtc('2026-07-01', '09:00', 'Europe/London').toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(localDateTimeToUtc('2026-01-01', '09:00', 'Europe/London').toISOString()).toBe('2026-01-01T09:00:00.000Z');
  });

  it('shifts non-existent DST-gap times forward', () => {
    // 2026-03-08 02:30 does not exist in New York (clocks jump 02:00 → 03:00).
    const d = zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York');
    const p = zonedParts(d, 'America/New_York');
    expect(p.hour).toBe(3);
    expect(p.minute).toBe(30);
  });

  it('resolves ambiguous fall-back times to the earlier instant', () => {
    const d = zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York');
    expect(d.toISOString()).toBe('2026-11-01T05:30:00.000Z'); // 01:30 EDT, not 01:30 EST
  });

  it('finds local midnight', () => {
    expect(startOfLocalDay('2026-03-07', 'Asia/Kolkata').toISOString()).toBe('2026-03-06T18:30:00.000Z');
  });

  it('does local date arithmetic', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(daysBetween('2026-03-01', '2026-03-07')).toBe(6);
    expect(weekdayOf('2026-10-16')).toBe(5); // Friday
    expect(parseLocalDate('2026-02-29')).toBeNull();
    expect(parseLocalDate('2028-02-29')).toEqual({ year: 2028, month: 2, day: 29 });
  });
});

describe('calendar occasions and leap-day policy', () => {
  it('matches ordinary birthdays only on their day', () => {
    expect(occasionsCelebratedOn('2026-03-07', 'feb28')).toEqual([{ month: 3, day: 7 }]);
  });

  it('celebrates 29 February birthdays on 28 February under the feb28 policy', () => {
    expect(occasionsCelebratedOn('2026-02-28', 'feb28')).toEqual([
      { month: 2, day: 28 },
      { month: 2, day: 29 },
    ]);
    expect(occasionsCelebratedOn('2026-03-01', 'feb28')).toEqual([{ month: 3, day: 1 }]);
  });

  it('celebrates 29 February birthdays on 1 March under the mar1 policy', () => {
    expect(occasionsCelebratedOn('2026-03-01', 'mar1')).toContainEqual({ month: 2, day: 29 });
    expect(occasionsCelebratedOn('2026-02-28', 'mar1')).toEqual([{ month: 2, day: 28 }]);
  });

  it('never duplicates a leap-day birthday in a leap year', () => {
    expect(occasionsCelebratedOn('2028-02-28', 'feb28')).toEqual([{ month: 2, day: 28 }]);
    expect(occasionsCelebratedOn('2028-02-29', 'feb28')).toEqual([{ month: 2, day: 29 }]);
    expect(occasionsCelebratedOn('2028-03-01', 'mar1')).toEqual([{ month: 3, day: 1 }]);
  });

  it('skips non-leap years under the skip policy', () => {
    expect(occasionsCelebratedOn('2026-02-28', 'skip')).toEqual([{ month: 2, day: 28 }]);
    expect(occasionsCelebratedOn('2026-03-01', 'skip')).toEqual([{ month: 3, day: 1 }]);
    expect(celebrationDate({ month: 2, day: 29 }, 2026, 'skip')).toBeNull();
    expect(nextCelebration({ month: 2, day: 29 }, '2026-03-01', 'skip')).toBe('2028-02-29');
  });

  it('finds the next celebration from a date', () => {
    expect(nextCelebration({ month: 3, day: 7 }, '2026-03-07', 'feb28')).toBe('2026-03-07');
    expect(nextCelebration({ month: 3, day: 7 }, '2026-03-08', 'feb28')).toBe('2027-03-07');
    expect(nextCelebration({ month: 2, day: 29 }, '2026-01-01', 'mar1')).toBe('2026-03-01');
  });

  it('lists occasion keys in a window across the new year', () => {
    const keys = occasionKeysInWindow('2026-12-30', 4, 'feb28');
    expect(keys.sort((a, b) => a - b)).toEqual([101, 102, 1230, 1231]);
  });

  it('computes completed years and ordinals for anniversaries', () => {
    expect(completedYears('2021-10-16', '2026-10-16')).toBe(5);
    expect(completedYears('2021-10-17', '2026-10-16')).toBe(4);
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(22)).toBe('22nd');
  });
});

describe('recurrence', () => {
  it('lists weekly occurrences in a time zone', () => {
    const occ = occurrencesBetween(
      { frequency: 'weekly', time: '10:00', daysOfWeek: [1] },
      new Date('2026-10-01T00:00:00Z'),
      new Date('2026-10-31T00:00:00Z'),
      'Asia/Kolkata',
    );
    expect(occ.map((d) => d.toISOString())).toEqual([
      '2026-10-05T04:30:00.000Z',
      '2026-10-12T04:30:00.000Z',
      '2026-10-19T04:30:00.000Z',
      '2026-10-26T04:30:00.000Z',
    ]);
  });

  it('clamps monthly schedules to the last day of short months', () => {
    const occ = occurrencesBetween(
      { frequency: 'monthly', time: '09:00', dayOfMonth: 31 },
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-04-15T00:00:00Z'),
      'UTC',
    );
    expect(occ.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });

  it('is exclusive of the start instant and inclusive of the end', () => {
    const rule = { frequency: 'daily' as const, time: '09:00' };
    const at = new Date('2026-03-07T09:00:00Z');
    expect(occurrencesBetween(rule, at, new Date('2026-03-08T09:00:00Z'), 'UTC').map((d) => d.toISOString())).toEqual([
      '2026-03-08T09:00:00.000Z',
    ]);
  });

  it('returns the next occurrence or null for finished one-off schedules', () => {
    const once = { frequency: 'once' as const, date: '2026-12-01', time: '08:00' };
    expect(nextOccurrence(once, new Date('2026-10-16T00:00:00Z'), 'UTC')?.toISOString()).toBe('2026-12-01T08:00:00.000Z');
    expect(nextOccurrence(once, new Date('2026-12-02T00:00:00Z'), 'UTC')).toBeNull();
    expect(nextOccurrence({ frequency: 'daily', time: '09:00' }, new Date('2026-10-16T10:00:00Z'), 'UTC')?.toISOString()).toBe(
      '2026-10-17T09:00:00.000Z',
    );
  });

  it('respects the occurrence limit after long downtime', () => {
    const occ = occurrencesBetween(
      { frequency: 'daily', time: '09:00' },
      new Date('2020-01-01T00:00:00Z'),
      new Date('2026-01-01T00:00:00Z'),
      'UTC',
      5,
    );
    expect(occ).toHaveLength(5);
  });

  it('describes schedules for humans', () => {
    expect(describeRecurrence({ frequency: 'weekly', time: '10:00', daysOfWeek: [3, 1] })).toBe('Every Mon, Wed at 10:00');
  });
});
