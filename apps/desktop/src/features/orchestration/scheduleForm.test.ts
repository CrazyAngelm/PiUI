import { describe, expect, it } from 'vitest';
import { localDateTimeToInstant, localDateTimeValue, positiveInteger } from './scheduleForm';

describe('schedule form values', () => {
  it('round-trips an exact minute in the declared time zone', () => {
    const local = localDateTimeValue('2026-09-09T10:15:00Z', 'UTC');
    const result = localDateTimeToInstant(local, 'UTC');
    expect(result.ok).toBe(true);
    if (result.ok) expect(localDateTimeValue(result.instant, 'UTC')).toBe(local);
  });

  it('does not substitute the browser zone for a saved IANA zone', () => {
    expect(localDateTimeValue('2026-09-09T10:15:00Z', 'Asia/Bangkok')).toBe('2026-09-09T17:15');
    expect(localDateTimeToInstant('2026-09-09T10:15', 'Asia/Bangkok')).toEqual({
      ok: true,
      instant: '2026-09-09T03:15:00.000Z',
    });
  });

  it('rejects skipped and repeated daylight-saving wall times', () => {
    expect(localDateTimeToInstant('2026-03-08T02:30', 'America/New_York')).toEqual({
      ok: false,
      reason: 'nonexistent',
    });
    expect(localDateTimeToInstant('2026-11-01T01:30', 'America/New_York')).toEqual({
      ok: false,
      reason: 'ambiguous',
    });
  });

  it('accepts only positive safe integer intervals', () => {
    expect(positiveInteger('1')).toBe(1);
    expect(positiveInteger('0')).toBeUndefined();
    expect(positiveInteger('1.5')).toBeUndefined();
    expect(positiveInteger(String(Number.MAX_SAFE_INTEGER + 1))).toBeUndefined();
  });
});
