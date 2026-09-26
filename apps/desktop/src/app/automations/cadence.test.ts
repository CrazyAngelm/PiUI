import { describe, expect, it } from 'vitest';
import { translate } from '../../features/locale/language';
import type { ScheduleTrigger } from '../../host-api/orchestrationClient';
import { cadenceText, eventPreview, OUTCOME, sortedOutcomes, triggerTimeZone, type Translate } from './cadence';

const english: Translate = (value, parameters = []) =>
  value.replace(/\{(\d+)\}/g, (token, index: string) => (Number(index) < parameters.length ? String(parameters[Number(index)]) : token));
const russian: Translate = (value, parameters = []) => english(translate(value, 'ru'), parameters);
const names = (id: string): string => ({ build: 'Build', deploy: 'Deploy' })[id] ?? '';

function finished(outcomes: ('succeeded' | 'failed' | 'cancelled')[]): ScheduleTrigger {
  return { type: 'event', event: { kind: 'run-finished', launchCommandId: 'build', outcomes } };
}

describe('automation cadence text', () => {
  it('names the watched pipeline and every outcome combination', () => {
    expect(cadenceText(finished(['succeeded']), english, 'en-US', names)).toBe('When Build succeeds');
    expect(cadenceText(finished(['failed']), english, 'en-US', names)).toBe('When Build fails');
    expect(cadenceText(finished(['cancelled']), english, 'en-US', names)).toBe('When Build is stopped');
    expect(cadenceText(finished(['failed', 'succeeded']), english, 'en-US', names)).toBe('When Build succeeds or fails');
    expect(cadenceText(finished(['cancelled', 'succeeded']), english, 'en-US', names)).toBe('When Build succeeds or is stopped');
    expect(cadenceText(finished(['cancelled', 'failed']), english, 'en-US', names)).toBe('When Build fails or is stopped');
    expect(cadenceText(finished(['succeeded', 'failed', 'cancelled']), english, 'en-US', names)).toBe('When Build finishes');
    const missing: ScheduleTrigger = { type: 'event', event: { kind: 'run-finished', launchCommandId: 'gone', outcomes: ['failed'] } };
    expect(cadenceText(missing, english, 'en-US', names)).toBe('When Missing pipeline fails');
  });

  it('shows the first file pattern and how many more there are', () => {
    const one: ScheduleTrigger = { type: 'event', event: { kind: 'files-changed', include: ['src/**/*.ts'], debounceSeconds: 10 } };
    const three: ScheduleTrigger = { type: 'event', event: { kind: 'files-changed', include: ['src/**', 'docs/', '*.md'], debounceSeconds: 10 } };
    expect(cadenceText(one, english, 'en-US', names)).toBe('When src/**/*.ts changes');
    expect(cadenceText(three, english, 'en-US', names)).toBe('When src/** and 2 more change');
  });

  it('keeps the timed rules readable', () => {
    expect(cadenceText({ type: 'interval', every: 2, unit: 'hours', anchorAt: '2026-09-27T10:00:00Z', timeZone: 'UTC' }, english, 'en-US', names)).toBe('Every 2 h');
    expect(cadenceText({ type: 'calendar', time: '09:00', days: [1, 2, 3, 4, 5], startsAt: '2026-09-27T10:00:00Z', timeZone: 'UTC' }, english, 'en-US', names))
      .toBe('Weekdays at 09:00');
    expect(cadenceText({ type: 'once', at: '2026-09-27T10:00:00Z', timeZone: 'UTC' }, english, 'en-US', names)).toBe('Once');
  });

  it('previews what an event rule promises, including loop protection', () => {
    expect(eventPreview({ kind: 'run-finished', launchCommandId: 'build', outcomes: ['succeeded'] }, 'Deploy', english, names)).toEqual([
      'When Build succeeds, PiUI starts Deploy.',
      'At most one run every 30 s. A chain of automations stops after 3 automatic runs.',
    ]);
    const files = eventPreview({ kind: 'files-changed', include: ['src/**'], exclude: ['src/gen/**'], debounceSeconds: 5 }, 'Tests', english, names);
    expect(files[0]).toBe('PiUI starts Tests 5 s after matching files stop changing.');
    expect(files[1]).toBe('Ignored: src/gen/**');
    expect(files).toHaveLength(4);
  });

  it('orders outcomes, keeps event rules in the local zone and labels every outcome', () => {
    expect(sortedOutcomes(['cancelled', 'succeeded', 'cancelled'])).toEqual(['succeeded', 'cancelled']);
    expect(triggerTimeZone(finished(['failed']), 'Europe/Berlin')).toBe('Europe/Berlin');
    expect(triggerTimeZone({ type: 'once', at: '2026-09-27T10:00:00Z', timeZone: 'Asia/Bangkok' }, 'UTC')).toBe('Asia/Bangkok');
    expect(Object.keys(OUTCOME).sort()).toEqual(['failed', 'skippedChainLimit', 'skippedCooldown', 'skippedMissed', 'skippedOverlap', 'skippedPaused', 'started']);
  });

  it('has Russian copy for every new sentence without translating pipeline names', () => {
    expect(cadenceText(finished(['succeeded', 'failed']), russian, 'ru-RU', names)).toContain('Build');
    for (const text of [
      cadenceText(finished(['succeeded']), russian, 'ru-RU', names),
      cadenceText(finished(['succeeded', 'failed', 'cancelled']), russian, 'ru-RU', names),
      ...eventPreview({ kind: 'files-changed', include: ['src/**'], exclude: ['x/**'], debounceSeconds: 5 }, 'Tests', russian, names),
    ]) {
      expect(text).toMatch(/[а-яё]/i);
    }
    for (const { label } of Object.values(OUTCOME)) expect(translate(label, 'ru'), label).not.toBe(label);
  });
});
