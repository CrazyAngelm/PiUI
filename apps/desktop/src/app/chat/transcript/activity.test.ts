import { describe, expect, it } from 'vitest';
import type { TimelineBlock } from '../../../host-api/types';
import { activityLine, activityState } from './toolKinds';

const block = (patch: Partial<TimelineBlock>): TimelineBlock => ({ id: 'b', kind: 'tool', label: 'Tool', status: 'complete', ...patch });

describe('activityState', () => {
  it('is quiet when every call finished', () => {
    expect(activityState([block({ id: 'a' }), block({ id: 'b' }), block({ id: 'c' })])).toEqual({
      live: false,
      failed: 0,
      stopped: false,
    });
  });

  it('counts the calls that failed', () => {
    const state = activityState([block({ id: 'a' }), block({ id: 'b', status: 'failed' }), block({ id: 'c' })]);
    expect(state).toMatchObject({ live: false, failed: 1, stopped: false });
  });

  it('is live while a call runs, even after an earlier failure', () => {
    const state = activityState([
      block({ id: 'a', status: 'failed' }),
      block({ id: 'b', status: 'streaming', title: 'Bash: npm test' }),
    ]);
    expect(state).toEqual({ live: true, failed: 1, stopped: false, current: 'Bash: npm test' });
  });

  it('marks a stopped call without calling it a failure', () => {
    const state = activityState([block({ id: 'a' }), block({ id: 'b', status: 'interrupted' })]);
    expect(state).toEqual({ live: false, failed: 0, stopped: true });
  });

  it('ignores the status of reasoning blocks', () => {
    const state = activityState([
      block({ id: 'a', kind: 'thinking', status: 'failed' }),
      block({ id: 'b', kind: 'thinking', status: 'interrupted' }),
      block({ id: 'c', kind: 'thinking', status: 'streaming' }),
      block({ id: 'd' }),
    ]);
    expect(state).toEqual({ live: false, failed: 0, stopped: false });
  });

  it('describes the later of two running calls', () => {
    const state = activityState([
      block({ id: 'a', status: 'streaming', title: 'first' }),
      block({ id: 'b', status: 'streaming', title: 'second' }),
    ]);
    expect(state.current).toBe('second');
  });
});

describe('activityLine', () => {
  it('prefers the title', () => {
    expect(activityLine(block({ title: 'Bash: npm test', text: 'Command: other' }))).toBe('Bash: npm test');
  });

  it('takes the command from the first line of the text', () => {
    expect(activityLine(block({ text: 'Command: npm test\nWorking directory: /w\nout' }))).toBe('npm test');
    expect(activityLine(block({ text: '$ pnpm test\n' }))).toBe('pnpm test');
  });

  it('falls back to the label, the tool name and then a generic word', () => {
    expect(activityLine(block({ label: 'Diff', toolName: 'edit' }))).toBe('Diff');
    expect(activityLine(block({ label: undefined, toolName: 'edit' }))).toBe('edit');
    expect(activityLine(block({ label: undefined }))).toBe('Tool');
  });

  it('cuts a long title to 160 characters', () => {
    expect(activityLine(block({ title: 'x'.repeat(300) }))).toHaveLength(160);
  });
});
