/**
 * Time source. Everything in the engine asks the clock for "now", so tests
 * and dry runs can simulate future dates (e.g. "pretend it is 7 March").
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export class ManualClock implements Clock {
  private current: number;

  constructor(start: Date | string | number = Date.now()) {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(at: Date | string | number): void {
    this.current = new Date(at).getTime();
  }

  advance(ms: number): void {
    this.current += ms;
  }

  advanceMinutes(minutes: number): void {
    this.advance(minutes * 60_000);
  }

  advanceDays(days: number): void {
    this.advance(days * 86_400_000);
  }
}

export function iso(clock: Clock): string {
  return clock.now().toISOString();
}
