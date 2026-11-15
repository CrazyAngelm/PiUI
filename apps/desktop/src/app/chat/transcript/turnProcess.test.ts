import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { language, loadRussian, translate } from '../../../features/locale/language';
import { lookupRussian } from '../../../features/locale/ruCatalog';
import type { TimelineTurnProcess } from '../../../features/sessions/timelineView';
import type { TimelineBlock } from '../../../host-api/types';
import { turnProcessLabel, turnSeconds } from './turnProcess';
import TurnProcessView from './TurnProcessView.svelte';

const tool = (id: string, patch: Partial<TimelineBlock> = {}): TimelineBlock => ({ id, kind: 'tool', status: 'complete', toolName: 'bash', ...patch });

const START = '2026-01-01T10:00:00.000Z';
const after = (seconds: number): string => new Date(Date.parse(START) + seconds * 1000).toISOString();

function control(patch: Partial<TimelineTurnProcess> = {}): TimelineTurnProcess {
  return {
    type: 'turn-process',
    id: 'turn:a',
    blocks: [tool('a'), tool('b'), tool('c', { toolName: 'edit' })],
    groups: 2,
    ...patch,
  };
}

const fill = (value: string, parameters: readonly unknown[]): string =>
  value.replace(/\{(\d+)\}/g, (token, index: string) => (Number(index) < parameters.length ? String(parameters[Number(index)]) : token));
const english = (value: string, parameters: readonly unknown[] = []): string => fill(value, parameters);
const russian = (value: string, parameters: readonly unknown[] = []): string => fill(translate(value, 'ru'), parameters);

describe('turnSeconds', () => {
  it('measures whole seconds between the two instants', () => {
    expect(turnSeconds({ startedAt: START, endedAt: after(7) })).toBe(7);
    expect(turnSeconds({ startedAt: START, endedAt: after(7.4) })).toBe(7);
  });

  it('is unknown without both instants, for a later start and for text that is not a date', () => {
    expect(turnSeconds({ endedAt: after(7) })).toBeUndefined();
    expect(turnSeconds({ startedAt: START })).toBeUndefined();
    expect(turnSeconds({ startedAt: after(7), endedAt: START })).toBeUndefined();
    expect(turnSeconds({ startedAt: START, endedAt: START })).toBeUndefined();
    expect(turnSeconds({ startedAt: 'soon', endedAt: after(7) })).toBeUndefined();
  });
});

describe('turnProcessLabel', () => {
  it('is the summary alone without a duration', () => {
    expect(turnProcessLabel(control(), 'en', english)).toBe('Edited 1 file, ran 2 commands');
  });

  it('puts a duration before the summary, whose first letter turns lower case', () => {
    expect(turnProcessLabel(control({ startedAt: START, endedAt: after(12) }), 'en', english)).toBe('Worked for 12s · edited 1 file, ran 2 commands');
    expect(turnProcessLabel(control({ startedAt: START, endedAt: after(75) }), 'en', english)).toBe('Worked for 1m 15s · edited 1 file, ran 2 commands');
    expect(turnProcessLabel(control({ startedAt: START, endedAt: after(3_600 + 5 * 60 + 9) }), 'en', english)).toBe('Worked for 1h 5m · edited 1 file, ran 2 commands');
  });

  it('is written in Russian once the catalog is loaded', async () => {
    await loadRussian();
    expect(turnProcessLabel(control({ startedAt: START, endedAt: after(12) }), 'ru', russian)).toBe('Работал 12 с · изменил 1 файл, выполнил 2 команды');
    expect(turnProcessLabel(control({ startedAt: START, endedAt: after(75) }), 'ru', russian)).toBe('Работал 1 мин 15 с · изменил 1 файл, выполнил 2 команды');
    expect(turnProcessLabel(control({ startedAt: START, endedAt: after(7_500) }), 'ru', russian)).toBe('Работал 2 ч 5 мин · изменил 1 файл, выполнил 2 команды');
    expect(turnProcessLabel(control(), 'ru', russian)).toBe('Изменил 1 файл, выполнил 2 команды');
  });

  it('has a Russian translation for every duration', () => {
    for (const key of ['Worked for {0}s', 'Worked for {0}m {1}s', 'Worked for {0}h {1}m']) expect(lookupRussian(key)).toBeDefined();
  });
});

/** Markup without the hydration comments the server render adds. */
const bare = (markup: string): string => markup.replace(/<!--[\s\S]*?-->/g, '');
const text = (markup: string): string => bare(markup).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

function view(item: TimelineTurnProcess, open = false): string {
  return render(TurnProcessView, { props: { item, language: 'en', open, onToggle: () => {} } }).body;
}

describe('TurnProcessView', () => {
  it('is one closed button with the summary', () => {
    const markup = view(control());
    expect(bare(markup).match(/<button\b/g)).toHaveLength(1);
    expect(markup).toContain('aria-expanded="false"');
    expect(text(markup)).toBe('Edited 1 file, ran 2 commands');
  });

  it('shows the duration first when it is known', () => {
    expect(text(view(control({ startedAt: START, endedAt: after(75) })))).toBe('Worked for 1m 15s · edited 1 file, ran 2 commands');
  });

  it('reports itself as open', () => {
    expect(view(control(), true)).toContain('aria-expanded="true"');
  });

  it('shows the lines the turn changed, in words for a screen reader', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,2 +1,3 @@', ' keep', '-old', '+new', '+more'].join('\n');
    const markup = view(control({ blocks: [tool('a'), tool('e', { toolName: 'edit', text: diff })] }));
    expect(text(markup)).toContain('+2');
    expect(text(markup)).toContain('−1');
    expect(markup).toContain('aria-label="2 lines added, 1 removed"');
    expect(text(view(control()))).not.toContain('+');
  });

  it('summarizes in Russian', async () => {
    await loadRussian();
    language.set('ru');
    try {
      const markup = render(TurnProcessView, { props: { item: control({ startedAt: START, endedAt: after(12) }), language: 'ru', open: false, onToggle: () => {} } }).body;
      expect(text(markup)).toBe('Работал 12 с · изменил 1 файл, выполнил 2 команды');
    } finally {
      language.set('en');
    }
  });
});
