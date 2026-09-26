/**
 * Calendar schedule arithmetic (orchestration schedules v7.1), mirroring
 * `CalendarRule` in `src-tauri/src/orchestration_schedule.rs`. The host is
 * authoritative; the UI uses this for previews and the UI Lab for due times.
 *
 * A calendar trigger fires at a local wall-clock `time` (`HH:MM`) on ISO
 * weekdays `days` (1 = Monday ... 7 = Sunday) in an IANA `timeZone`, never
 * before `startsAt`. A local time skipped by a clock change fires at the first
 * valid minute after the gap; a repeated local time fires once, at the first.
 */
export interface CalendarTrigger {
  readonly type: 'calendar';
  readonly time: string;
  readonly days: readonly number[];
  readonly startsAt: string;
  readonly timeZone: string;
}

const MINUTE = 60_000;
const DAY = 86_400_000;
const MAX_GAP_MINUTES = 180;
const SEARCH_DAYS = 9;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/u;

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const WORKDAYS = [1, 2, 3, 4, 5] as const;

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat | undefined {
  let value = formatters.get(timeZone);
  if (!value) {
    try {
      value = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return undefined;
    }
    formatters.set(timeZone, value);
  }
  return value;
}

export function validTimeZone(timeZone: string): boolean {
  return timeZone.trim() !== '' && formatter(timeZone) !== undefined;
}

function wall(instant: number, timeZone: string): Wall | undefined {
  const parts = formatter(timeZone)?.formatToParts(new Date(instant));
  if (!parts) return undefined;
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const value = { year: read('year'), month: read('month'), day: read('day'), hour: read('hour'), minute: read('minute'), second: read('second') };
  return Object.values(value).every(Number.isFinite) ? value : undefined;
}

/** Instants whose wall time in `timeZone` equals the given civil minute. */
function candidates(civil: number, timeZone: string): number[] {
  const offsets = new Set<number>();
  for (const delta of [-2 * DAY, -DAY, 0, DAY, 2 * DAY]) {
    const sampledAt = civil + delta;
    const sampled = wall(sampledAt, timeZone);
    if (!sampled) return [];
    offsets.add(Date.UTC(sampled.year, sampled.month - 1, sampled.day, sampled.hour, sampled.minute, sampled.second) - sampledAt);
  }
  return [...new Set([...offsets].map((offset) => civil - offset))]
    .filter((instant) => {
      const back = wall(instant, timeZone);
      return back !== undefined && Date.UTC(back.year, back.month - 1, back.day, back.hour, back.minute) === civil;
    })
    .sort((left, right) => left - right);
}

function parseTime(value: string): { hour: number; minute: number } | undefined {
  const match = TIME.exec(value);
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : undefined;
}

export function calendarValid(trigger: CalendarTrigger): boolean {
  const days = trigger.days;
  return (
    parseTime(trigger.time) !== undefined &&
    validTimeZone(trigger.timeZone) &&
    Number.isFinite(Date.parse(trigger.startsAt)) &&
    days.length >= 1 &&
    days.length <= 7 &&
    new Set(days).size === days.length &&
    days.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)
  );
}

/** ISO weekday (1 = Monday) of a UTC-midnight civil date. */
function isoWeekday(civilDate: number): number {
  const day = new Date(civilDate).getUTCDay();
  return day === 0 ? 7 : day;
}

function occurrenceOn(trigger: CalendarTrigger, civilDate: number): number | undefined {
  const time = parseTime(trigger.time);
  if (!time || !trigger.days.includes(isoWeekday(civilDate))) return undefined;
  const civil = civilDate + time.hour * 60 * MINUTE + time.minute * MINUTE;
  for (let minutes = 0; minutes <= MAX_GAP_MINUTES; minutes += 1) {
    const found = candidates(civil + minutes * MINUTE, trigger.timeZone)[0];
    if (found !== undefined) return found;
  }
  return undefined;
}

function localDate(instant: number, timeZone: string): number | undefined {
  const value = wall(instant, timeZone);
  return value ? Date.UTC(value.year, value.month - 1, value.day) : undefined;
}

/** First occurrence strictly after `instant` and not before `startsAt`. */
export function calendarFirstAfter(trigger: CalendarTrigger, instant: number): number | undefined {
  if (!calendarValid(trigger)) return undefined;
  const startsAt = Date.parse(trigger.startsAt);
  const floor = Math.max(instant, startsAt - 1);
  const first = localDate(floor, trigger.timeZone);
  if (first === undefined) return undefined;
  for (let offset = -1; offset <= SEARCH_DAYS; offset += 1) {
    const candidate = occurrenceOn(trigger, first + offset * DAY);
    if (candidate !== undefined && candidate > floor && candidate >= startsAt) return candidate;
  }
  return undefined;
}

/** First due instant of a newly saved or edited calendar trigger. */
export function calendarInitialDue(trigger: CalendarTrigger): number {
  const startsAt = Date.parse(trigger.startsAt);
  return calendarFirstAfter(trigger, startsAt - 1) ?? startsAt;
}

/** Distinct ISO weekdays in week order. */
export function sortDays(days: readonly number[]): number[] {
  return [...new Set(days)].sort((left, right) => left - right);
}

/** Whether a day selection is a named preset. */
export function daySet(days: readonly number[]): 'every' | 'workdays' | 'custom' {
  const key = sortDays(days).join();
  return key === WEEKDAYS.join() ? 'every' : key === WORKDAYS.join() ? 'workdays' : 'custom';
}

export function validTime(value: string): boolean {
  return parseTime(value) !== undefined;
}

/** Weekday names in the reader's language, Monday first. */
export function weekdayNames(locale: string, style: 'short' | 'long' = 'short'): string[] {
  const format = new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' });
  // 2024-01-01 was a Monday.
  return WEEKDAYS.map((day) => format.format(new Date(Date.UTC(2024, 0, day))));
}
