import { describe, expect, it } from 'vitest';
import { calendarFirstAfter, calendarInitialDue, calendarValid, daySet, sortDays, validTime, weekdayNames, type CalendarTrigger } from './scheduleCalendar';

function calendar(time: string, days: number[], startsAt: string, timeZone: string): CalendarTrigger {
  return { type: 'calendar', time, days, startsAt, timeZone };
}
const at = (value: string) => Date.parse(value);
const iso = (value: number | undefined) => (value === undefined ? undefined : new Date(value).toISOString().replace('.000Z', 'Z'));

// Same fixtures as the Rust tests in orchestration_schedule.rs.
describe('calendar schedules', () => {
  it('runs at local wall time on selected weekdays', () => {
    const trigger = calendar('09:00', [1, 2, 3, 4, 5], '2026-09-25T10:00:00Z', 'Europe/Moscow');
    expect(calendarValid(trigger)).toBe(true);
    expect(iso(calendarInitialDue(trigger))).toBe('2026-09-28T06:00:00Z');
    expect(iso(calendarFirstAfter(trigger, at('2026-09-28T06:00:00Z')))).toBe('2026-09-29T06:00:00Z');
  });

  it('follows daylight saving changes', () => {
    const daily = calendar('08:00', [1, 2, 3, 4, 5, 6, 7], '2026-10-23T00:00:00Z', 'Europe/Berlin');
    expect(iso(calendarFirstAfter(daily, at('2026-10-24T12:00:00Z')))).toBe('2026-10-25T07:00:00Z');
    expect(iso(calendarFirstAfter(daily, at('2026-10-23T12:00:00Z')))).toBe('2026-10-24T06:00:00Z');
    const gap = calendar('02:30', [7], '2026-03-01T00:00:00Z', 'Europe/Berlin');
    expect(iso(calendarFirstAfter(gap, at('2026-03-28T00:00:00Z')))).toBe('2026-03-29T01:00:00Z');
    const repeated = calendar('02:30', [7], '2026-10-01T00:00:00Z', 'Europe/Berlin');
    expect(iso(calendarFirstAfter(repeated, at('2026-10-24T00:00:00Z')))).toBe('2026-10-25T00:30:00Z');
  });

  it('rejects malformed rules', () => {
    for (const trigger of [
      calendar('9:00', [1], '2026-09-25T00:00:00Z', 'UTC'),
      calendar('24:00', [1], '2026-09-25T00:00:00Z', 'UTC'),
      calendar('09:60', [1], '2026-09-25T00:00:00Z', 'UTC'),
      calendar('09:00', [], '2026-09-25T00:00:00Z', 'UTC'),
      calendar('09:00', [0], '2026-09-25T00:00:00Z', 'UTC'),
      calendar('09:00', [8], '2026-09-25T00:00:00Z', 'UTC'),
      calendar('09:00', [1, 1], '2026-09-25T00:00:00Z', 'UTC'),
      calendar('09:00', [1], '2026-09-25T00:00:00Z', 'Mars/Olympus'),
    ]) {
      expect(calendarValid(trigger)).toBe(false);
    }
  });

  it('recognises day presets and times', () => {
    expect(sortDays([5, 1, 3, 1])).toEqual([1, 3, 5]);
    expect(daySet([7, 6, 5, 4, 3, 2, 1])).toBe('every');
    expect(daySet([5, 4, 3, 2, 1])).toBe('workdays');
    expect(daySet([1, 3])).toBe('custom');
    expect(validTime('07:05')).toBe(true);
    expect(validTime('7:05')).toBe(false);
  });

  it('names weekdays Monday first', () => {
    expect(weekdayNames('en-US')).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  });
});
