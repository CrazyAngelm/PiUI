import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { language, loadRussian, translate } from '../../../features/locale/language';
import { lookupRussian } from '../../../features/locale/ruCatalog';
import { groupTranscriptBlocks, type TimelineTurnProcess } from '../../../features/sessions/timelineView';
import type { TimelineBlock } from '../../../host-api/types';
import { processDiffTotals, processLive, turnProcessLabel, turnSeconds } from './turnProcess';
import TurnProcessView from './TurnProcessView.svelte';

const tool = (id: string, patch: Partial<TimelineBlock> = {}): TimelineBlock => ({ id, kind: 'tool', status: 'complete', toolName: 'bash', ...patch });
const user: TimelineBlock = { id: 'user', kind: 'user', status: 'complete' };
const reply = (id: string, text: string): TimelineBlock => ({ id, kind: 'assistant', status: 'complete', text });

const START = '2026-01-01T10:00:00.000Z';
const after = (seconds: number): string => new Date(Date.parse(START) + seconds * 1000).toISOString();

/** The process the transcript builds for these blocks, with fields of its own overridden. */
function control(patch: Partial<TimelineTurnProcess> = {}, blocks: readonly TimelineBlock[] = [tool('a'), tool('b'), tool('c', { toolName: 'edit' })], running = false): TimelineTurnProcess {
  const item = groupTranscriptBlocks(blocks, running).find((entry) => entry.type === 'turn-process');
  if (item?.type !== 'turn-process') throw new Error('Expected a process.');
  return { ...item, ...patch };
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

describe('processLive', () => {
  it('names the running call of a process that is still at work', () => {
    const item = control({}, [user, tool('a'), tool('b', { status: 'streaming', title: 'Bash: npm test' })], true);
    expect(processLive(item, 'en')).toEqual({ label: 'Running a command', detail: 'Bash: npm test' });
  });

  it('is nothing for a finished process', () => {
    expect(processLive(control({}, [user, tool('a'), reply('answer', 'Done')]), 'en')).toBeUndefined();
  });
});

describe('processDiffTotals', () => {
  const diff = (name: string, ...lines: string[]): string => [`--- a/${name}`, `+++ b/${name}`, '@@ -1,1 +1,2 @@', ' keep', ...lines].join('\n');

  it('adds up the edits of every group', () => {
    const item = control({}, [
      user,
      tool('e1', { toolName: 'edit', text: diff('x.ts', '+one') }),
      reply('note', 'Next'),
      tool('e2', { toolName: 'edit', text: diff('y.ts', '+two', '+three') }),
      reply('answer', 'Done'),
    ]);
    expect(item.groups).toBe(2);
    expect(processDiffTotals(item)).toEqual({ added: 3, removed: 0 });
    // The second read comes from the groups' cache and agrees.
    expect(processDiffTotals(item)).toEqual({ added: 3, removed: 0 });
  });

  it('is nothing when no group edited a file', () => {
    expect(processDiffTotals(control())).toBeUndefined();
  });
});

/** Markup without the hydration comments the server render adds. */
const bare = (markup: string): string => markup.replace(/<!--[\s\S]*?-->/g, '');
const text = (markup: string): string => bare(markup).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

function view(item: TimelineTurnProcess, open = false, lang: 'en' | 'ru' = 'en'): string {
  return render(TurnProcessView, { props: { item, language: lang, open, onToggle: () => {}, openState: {}, onOpenChange: () => {} } }).body;
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

  it('shows the lines the process changed, in words for a screen reader', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,2 +1,3 @@', ' keep', '-old', '+new', '+more'].join('\n');
    const markup = view(control({}, [tool('a'), tool('e', { toolName: 'edit', text: diff })]));
    expect(text(markup)).toContain('+2');
    expect(text(markup)).toContain('−1');
    expect(markup).toContain('aria-label="2 lines added, 1 removed"');
    expect(text(view(control()))).not.toContain('+');
  });

  it('counts failed calls in words and marks a stopped one', () => {
    expect(text(view(control({}, [tool('a'), tool('b', { status: 'failed' })])))).toContain('1 failed');
    const stopped = text(view(control({}, [tool('a'), tool('b', { status: 'interrupted' })])));
    expect(stopped).toContain('Stopped');
    expect(stopped).not.toContain('failed');
  });

  it('says what a working process does now, in place of its counts', () => {
    const markup = view(control({}, [user, tool('a'), tool('b', { status: 'streaming', title: 'Bash: npm test' })], true));
    expect(text(markup)).toMatch(/^Running a command · Bash: npm test/);
    expect(text(markup)).not.toContain('Ran');
    expect(markup).toContain('spinner');
  });

  it('keeps the diff totals and the failed calls of a working process in view', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,1 +1,2 @@', ' keep', '+new'].join('\n');
    const markup = view(control({}, [user, tool('e', { toolName: 'edit', text: diff }), tool('f', { status: 'failed' }), tool('b', { status: 'streaming', title: 'Bash: pnpm check' })], true));
    expect(markup).toContain('aria-label="1 lines added, 0 removed"');
    expect(text(markup)).toContain('1 failed');
  });

  it('shows no spinner once the process is finished', () => {
    expect(view(control({}, [user, tool('a'), reply('answer', 'Done')]))).not.toContain('spinner');
  });

  describe('open', () => {
    const turn = [user, tool('a', { title: 'pnpm test', text: 'ok' }), reply('note', 'Now I check the config'), tool('b', { title: 'pnpm check', text: 'ok' }), reply('answer', 'Done')];

    it('lists the calls of a lone group at once, with no header of its own', () => {
      const markup = bare(view(control({}, [user, tool('a', { title: 'pnpm test', text: 'ok' }), tool('b', { title: 'pnpm check', text: 'ok' }), reply('answer', 'Done')]), true));
      expect(markup).not.toContain('group__head');
      expect(markup.match(/class="row /g)).toHaveLength(2);
      expect(text(markup)).toContain('pnpm test');
      expect(text(markup)).toContain('pnpm check');
    });

    it('outlines several groups, with the replies written between them', () => {
      const markup = bare(view(control({}, turn), true));
      expect(markup.match(/group__head/g)?.length).toBeGreaterThanOrEqual(2);
      expect(text(markup)).toContain('Now I check the config');
      expect(markup).toContain('data-timeline-block="note"');
      // The groups are closed until the reader opens one.
      expect(markup).not.toContain('class="row ');
    });

    it('keeps the replies out of a closed process', () => {
      expect(text(view(control({}, turn)))).not.toContain('Now I check the config');
    });

    it('opens a group the reader opened', () => {
      const item = control({}, [user, tool('a', { title: 'pnpm test', text: 'ok' }), tool('b', { title: 'pnpm lint', text: 'ok' }), reply('note', 'Now I check the config'), tool('c', { title: 'pnpm check', text: 'ok' }), reply('answer', 'Done')]);
      const first = item.parts[0];
      if (first?.type !== 'activity-group') throw new Error('Expected a group.');
      const markup = render(TurnProcessView, {
        props: { item, language: 'en', open: true, onToggle: () => {}, openState: { [first.id]: true }, onOpenChange: () => {} },
      }).body;
      expect(bare(markup).match(/class="row /g)).toHaveLength(2);
    });
  });

  it('summarizes in Russian', async () => {
    await loadRussian();
    language.set('ru');
    try {
      expect(text(view(control({ startedAt: START, endedAt: after(12) }), false, 'ru'))).toBe('Работал 12 с · изменил 1 файл, выполнил 2 команды');
      expect(text(view(control({}, [user, tool('a', { status: 'streaming', title: 'Bash: ls' })], true), false, 'ru'))).toMatch(/^Выполняет команду · Bash: ls/);
    } finally {
      language.set('en');
    }
  });
});
