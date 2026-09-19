export type LocalInstantResult =
  | { readonly ok: true; readonly instant: string }
  | { readonly ok: false; readonly reason: 'invalid' | 'nonexistent' | 'ambiguous' };

const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

type WallParts = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
};

function wallParts(instant: string | number, timeZone: string): WallParts | undefined {
  const value = new Date(instant);
  if (Number.isNaN(value.getTime())) return undefined;
  try {
    const formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = Object.fromEntries(
      formatter
        .formatToParts(value)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)]),
    );
    const result = {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: parts.hour,
      minute: parts.minute,
      second: parts.second,
    };
    return Object.values(result).every(Number.isFinite) ? result : undefined;
  } catch {
    return undefined;
  }
}

export function localDateTimeValue(instant: string, timeZone: string): string {
  const value = wallParts(instant, timeZone);
  if (!value) return '';
  const part = (number: number) => String(number).padStart(2, '0');
  return `${value.year}-${part(value.month)}-${part(value.day)}T${part(value.hour)}:${part(value.minute)}`;
}

export function localDateTimeToInstant(value: string, timeZone: string): LocalInstantResult {
  const match = LOCAL_PATTERN.exec(value);
  if (!match) return { ok: false, reason: 'invalid' };
  const [, year, month, day, hour, minute] = match;
  const fields = [Number(year), Number(month), Number(day), Number(hour), Number(minute)] as const;
  const wallTime = Date.UTC(fields[0], fields[1] - 1, fields[2], fields[3], fields[4]);
  const normalized = new Date(wallTime);
  if (
    normalized.getUTCFullYear() !== fields[0]
    || normalized.getUTCMonth() + 1 !== fields[1]
    || normalized.getUTCDate() !== fields[2]
    || normalized.getUTCHours() !== fields[3]
    || normalized.getUTCMinutes() !== fields[4]
  ) {
    return { ok: false, reason: 'invalid' };
  }

  // Offsets immediately before and after a civil-time transition are enough
  // to recover both candidates for a repeated time and none for a skipped
  // time. The wider samples also cover date-line transitions.
  const offsets = new Set<number>();
  for (const delta of [-172_800_000, -86_400_000, 0, 86_400_000, 172_800_000]) {
    const sampledAt = wallTime + delta;
    const sampled = wallParts(sampledAt, timeZone);
    if (!sampled) return { ok: false, reason: 'invalid' };
    offsets.add(
      Date.UTC(sampled.year, sampled.month - 1, sampled.day, sampled.hour, sampled.minute, sampled.second)
        - sampledAt,
    );
  }
  const matches = [...offsets]
    .map((offset) => wallTime - offset)
    .filter((instant, index, values) => values.indexOf(instant) === index)
    .filter((instant) => localDateTimeValue(new Date(instant).toISOString(), timeZone) === value);
  if (matches.length === 0) return { ok: false, reason: 'nonexistent' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, instant: new Date(matches[0]).toISOString() };
}

export function positiveInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
