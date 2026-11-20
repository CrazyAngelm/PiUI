import { describe, expect, it } from 'vitest';
import type { TimelineBlock } from '../../../host-api/types';
import { activityLine, activityLive, activityState, activitySummary, leadingKind, reasoningPreview, toolKind } from './toolKinds';

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

  it('names a generic tool without its arguments, but keeps a delegation whole', () => {
    expect(activityLine(block({ toolName: 'agent_join', title: 'agent_join: id: 1, timeoutMs: 120000' }))).toBe('agent_join');
    expect(activityLine(block({ toolName: 'subagent', title: 'subagent: agent: scout, task: Find the crash' }))).toBe('subagent: agent: scout, task: Find the crash');
  });

  it('cuts a long title to 160 characters', () => {
    expect(activityLine(block({ title: 'x'.repeat(300) }))).toHaveLength(160);
  });
});

describe('toolKind', () => {
  it.each(['agent', 'Task', 'subagent', 'spawn_agent', 'collab-agent', 'workspace.read'])('calls %s a delegation', (toolName) => {
    expect(toolKind(block({ toolName, label: 'Tool' }))).toBe('agent');
  });

  it('keeps the other kinds', () => {
    expect(toolKind(block({ toolName: 'bash' }))).toBe('command');
    expect(toolKind(block({ toolName: 'agents-md' }))).toBe('tool');
    expect(toolKind(block({ kind: 'thinking' }))).toBe('thinking');
  });

  it('summarizes delegations by name', () => {
    expect(activitySummary([block({ toolName: 'Task' }), block({ id: 'b', toolName: 'Task' })], 'en')).toBe('Delegated 2 tasks');
  });
});

describe('leadingKind', () => {
  it('takes the first kind of the summary order that occurs', () => {
    expect(leadingKind([block({ toolName: 'read' }), block({ id: 'b', toolName: 'bash' })])).toBe('command');
    expect(leadingKind([block({ toolName: 'grep' }), block({ id: 'b', toolName: 'edit' })])).toBe('edit');
    expect(leadingKind([block({ toolName: 'grep' }), block({ id: 'b', toolName: 'task' })])).toBe('agent');
  });

  it('names reasoning only when nothing else occurs', () => {
    expect(leadingKind([block({ kind: 'thinking' }), block({ id: 'b', toolName: 'mystery' })])).toBe('tool');
    expect(leadingKind([block({ kind: 'thinking' }), block({ id: 'b', kind: 'thinking' })])).toBe('thinking');
  });
});

describe('reasoningPreview', () => {
  it('gives the first non-empty line of finished text', () => {
    expect(reasoningPreview('\n\n  Check the tests first  \nthen the build')).toBe('Check the tests first');
  });

  it('gives the first line of the last paragraph of text still streaming', () => {
    expect(reasoningPreview('Plan\nstep one\n\nNow reading\nthe scheduler\n\n', true)).toBe('Now reading');
    expect(reasoningPreview('Only one paragraph\nwith two lines', true)).toBe('Only one paragraph');
  });

  it('removes bold markers and collapses whitespace', () => {
    expect(reasoningPreview('**Plan:**   read\tthe   test')).toBe('Plan: read the test');
  });

  it('cuts a long line to 160 characters with an ellipsis', () => {
    const preview = reasoningPreview('x'.repeat(300));
    expect(preview).toHaveLength(160);
    expect(preview.endsWith('…')).toBe(true);
    expect(reasoningPreview('y'.repeat(160))).toHaveLength(160);
    expect(reasoningPreview('y'.repeat(160))).not.toContain('…');
  });

  it('is empty for empty text', () => {
    expect(reasoningPreview('')).toBe('');
    expect(reasoningPreview(' \n \n', true)).toBe('');
  });
});

describe('activityLive', () => {
  it('names the latest running call and shows its line', () => {
    const blocks = [
      block({ id: 'a', toolName: 'bash', status: 'streaming', title: 'first' }),
      block({ id: 'b', toolName: 'edit', status: 'streaming', title: 'src/app.ts' }),
      block({ id: 'c', toolName: 'read' }),
    ];
    expect(activityLive(blocks, 'en')).toEqual({ label: 'Editing files', detail: 'src/app.ts' });
  });

  it.each([
    ['bash', 'Running a command', 'Выполняет команду'],
    ['edit', 'Editing files', 'Изменяет файлы'],
    ['read', 'Reading files', 'Читает файлы'],
    ['grep', 'Searching', 'Ищет'],
    ['websearch', 'Searching the web', 'Ищет в интернете'],
    ['task', 'Delegating', 'Поручает задачу'],
    ['mystery', 'Using a tool', 'Использует инструмент'],
  ])('labels a running %s call', (toolName, en, ru) => {
    const blocks = [block({ toolName, status: 'streaming', title: 'now' })];
    expect(activityLive(blocks, 'en')).toEqual({ label: en, detail: 'now' });
    expect(activityLive(blocks, 'ru')).toEqual({ label: ru, detail: 'now' });
  });

  it('prefers a running call to streaming reasoning', () => {
    const blocks = [
      block({ id: 'a', kind: 'thinking', status: 'streaming', text: 'Weighing options' }),
      block({ id: 'b', toolName: 'bash', status: 'streaming', text: '$ pnpm test' }),
    ];
    expect(activityLive(blocks, 'en')).toEqual({ label: 'Running a command', detail: 'pnpm test' });
  });

  it('follows the reasoning when no call runs', () => {
    const blocks = [
      block({ id: 'a', toolName: 'bash' }),
      block({ id: 'b', kind: 'thinking', status: 'streaming', text: 'Plan\n\n**Now** checking the tests\nsecond line' }),
    ];
    expect(activityLive(blocks, 'en')).toEqual({ label: 'Thinking', detail: 'Now checking the tests' });
    expect(activityLive(blocks, 'ru').label).toBe('Думает');
  });

  it('says only that it works when nothing is running', () => {
    expect(activityLive([block({ toolName: 'bash' })], 'en')).toEqual({ label: 'Working' });
    expect(activityLive([block({ toolName: 'bash' })], 'ru')).toEqual({ label: 'Работает' });
    expect(activityLive([block({ kind: 'thinking', status: 'streaming', text: '' })], 'en')).toEqual({ label: 'Thinking' });
  });

  it('ignores a call that stopped and reasoning that finished', () => {
    const blocks = [block({ id: 'a', toolName: 'bash', status: 'interrupted' }), block({ id: 'b', kind: 'thinking', status: 'complete', text: 'x' })];
    expect(activityLive(blocks, 'en')).toEqual({ label: 'Working' });
  });
});
