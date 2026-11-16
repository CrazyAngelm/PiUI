import { forgetBlockStarts, noteBlockStart } from '../../../features/workspace/blockStarts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionSnapshot } from '../../../host-api/workspaceClient';
import type { SessionTaskV1 } from '../../../../../../contracts/workspace-session-tasks-v1';
import { elapsedLabel, sessionActivity, usageLine, type ActivityItem } from './sessionActivity';

beforeEach(forgetBlockStarts);

const MINUTE = 60_000;
const BASE = Date.parse('2026-11-17T10:00:00Z');
const at = (minutes: number): string => new Date(BASE + minutes * MINUTE).toISOString();

type Block = SessionSnapshot['blocks'][number];

function snapshot(status: SessionSnapshot['session']['status'], blocks: Block[] = [], tasks?: unknown): SessionSnapshot {
  return {
    revision: 1,
    session: { id: 'session-a', workspaceId: 'project-a', harness: 'claude-code', title: 'Chat', status, updatedAt: at(0) },
    blocks,
    approvals: [],
    capabilities: {
      prompt: { supported: true, enforcement: 'native' },
      resume: { supported: true, enforcement: 'native' },
      models: { supported: true, enforcement: 'native' },
      approvals: { supported: true, enforcement: 'native' },
      instructions: { supported: false, enforcement: 'unsupported' },
      toolPolicy: { supported: false, enforcement: 'unsupported' },
      nativeSubagents: { supported: false, enforcement: 'unsupported' },
    },
    models: [],
    ...(tasks === undefined ? {} : { tasks: tasks as SessionTaskV1[] }),
  };
}

const task = (patch: Partial<SessionTaskV1> & { id: string }): SessionTaskV1 => ({
  kind: 'command', title: patch.id, status: 'running', background: false, startedAt: at(0), ...patch,
});

const tool = (patch: Partial<Block> & { id: string }): Block => ({ kind: 'tool', label: 'Tool', status: 'streaming', ...patch });

describe('sessionActivity: which sessions are live', () => {
  const tasks = [task({ id: 'a', kind: 'agent' })];
  it('has nothing for no snapshot, a closed session or a failed one', () => {
    const empty = { agents: [], commands: [], other: [], running: 0, ongoing: 0 };
    expect(sessionActivity(undefined)).toEqual(empty);
    expect(sessionActivity(snapshot('closed', [], tasks))).toEqual(empty);
    expect(sessionActivity(snapshot('failed', [], tasks))).toEqual(empty);
  });

  it('lists native tasks while the session is starting, idle, running or stopping', () => {
    for (const status of ['starting', 'idle', 'running', 'stopping'] as const) {
      expect(sessionActivity(snapshot(status, [], tasks)).agents, status).toHaveLength(1);
    }
  });
});

describe('sessionActivity: native tasks', () => {
  it('maps every field and groups by kind', () => {
    const view = sessionActivity(snapshot('idle', [], [
      task({ id: 'agent-1', kind: 'agent', title: 'Review the diff', background: true, detail: 'general-purpose', activity: 'Reading a file', toolUses: 7, totalTokens: 18_400, startedAt: at(1) }),
      task({ id: 'cmd-1', kind: 'command', title: 'pnpm dev', detail: 'Start the UI Lab', startedAt: at(2) }),
      task({ id: 'misc-1', kind: 'task', title: 'Something else', startedAt: at(3) }),
    ]));
    expect(view.agents).toEqual([{
      id: 'task:agent-1', kind: 'agent', title: 'Review the diff', status: 'running', background: true,
      startedAt: BASE + MINUTE, detail: 'general-purpose', activity: 'Reading a file', toolUses: 7, totalTokens: 18_400, taskId: 'agent-1',
    }]);
    expect(view.commands.map((item) => item.title)).toEqual(['pnpm dev']);
    expect(view.other.map((item) => item.title)).toEqual(['Something else']);
    expect(view.running).toBe(3);
  });

  it('offers a task id only while the task runs', () => {
    const view = sessionActivity(snapshot('idle', [], [
      task({ id: 'live' }),
      task({ id: 'done', status: 'completed', endedAt: at(2) }),
      task({ id: 'bad', status: 'failed', endedAt: at(2) }),
      task({ id: 'cut', status: 'stopped', endedAt: at(2) }),
    ]));
    const byId = Object.fromEntries(view.commands.map((item) => [item.id, item]));
    expect(byId['task:live']?.taskId).toBe('live');
    for (const id of ['task:done', 'task:bad', 'task:cut']) {
      expect(byId[id]).toBeDefined();
      expect(byId[id]).not.toHaveProperty('taskId');
    }
    expect(byId['task:done']).toMatchObject({ endedAt: BASE + 2 * MINUTE });
    expect(view.running).toBe(1);
  });

  it('turns an unknown kind into a generic task and keeps only finite instants', () => {
    const view = sessionActivity(snapshot('idle', [], [
      { id: 'odd', kind: 'workflow', title: 'Odd', status: 'running', background: true, startedAt: 'not a date', endedAt: 'nope' },
    ]));
    expect(view.other).toHaveLength(1);
    expect(view.other[0]).not.toHaveProperty('startedAt');
    expect(view.other[0]).not.toHaveProperty('endedAt');
  });

  it('ignores malformed entries and entries with an unknown status', () => {
    const view = sessionActivity(snapshot('idle', [], [
      null,
      'text',
      42,
      { title: 'no id', status: 'running', startedAt: at(0) },
      { id: 'no-title', status: 'running', startedAt: at(0) },
      { id: 'no-start', title: 'No start', status: 'running' },
      { id: 'weird', kind: 'command', title: 'Weird', status: 'paused', startedAt: at(0) },
      { id: 'good', kind: 'command', title: 'Good', status: 'running', startedAt: at(0), toolUses: -1, totalTokens: 'many', detail: 7 },
      { id: 'good', kind: 'command', title: 'Duplicate', status: 'running', startedAt: at(0) },
    ]));
    expect(view.commands.map((item) => item.title)).toEqual(['Good']);
    expect(view.commands[0]).not.toHaveProperty('toolUses');
    expect(view.commands[0]).not.toHaveProperty('totalTokens');
    expect(view.commands[0]).not.toHaveProperty('detail');
  });

  it('survives a tasks field that is not a list', () => {
    expect(sessionActivity(snapshot('idle', [], { id: 'x' })).running).toBe(0);
    expect(sessionActivity(snapshot('idle', [], 'x')).running).toBe(0);
  });
});

describe('sessionActivity: running tool calls of the timeline', () => {
  it('derives agents and commands from streaming tool blocks and strips the tool name from the title', () => {
    const view = sessionActivity(snapshot('running', [
      tool({ id: 'b1', toolName: 'Bash', title: 'Bash: pnpm test', createdAt: at(1) }),
      tool({ id: 'b2', toolName: 'Agent', title: 'Agent: Review the diff', createdAt: at(2) }),
      tool({ id: 'b3', toolName: 'Read', title: 'Read: a.ts' }),
      tool({ id: 'b4', toolName: 'Bash', title: 'Bash: done', status: 'complete' }),
      { id: 'b5', kind: 'thinking', label: 'Thinking', status: 'streaming' },
    ]));
    expect(view.commands).toEqual([{ id: 'block:b1', kind: 'command', title: 'pnpm test', status: 'running', background: false }]);
    expect(view.agents).toEqual([{ id: 'block:b2', kind: 'agent', title: 'Review the diff', status: 'running', background: false }]);
    expect(view.other).toEqual([]);
    expect(view.running).toBe(2);
    expect(view.commands[0]).not.toHaveProperty('taskId');
  });

  it('strips only an exact "<tool name>: " prefix', () => {
    const view = sessionActivity(snapshot('running', [
      tool({ id: 'b1', toolName: 'Bash', title: 'bash: lower case' }),
      tool({ id: 'b2', toolName: 'Bash', title: 'Bash -lc "echo"' }),
      tool({ id: 'b3', toolName: 'Bash', title: 'Bash: ' }),
    ]));
    expect(view.commands.map((item) => item.title).sort()).toEqual(['Bash -lc "echo"', 'Bash:', 'bash: lower case']);
  });

  it('shows timeline calls only while a turn is active', () => {
    const blocks = [tool({ id: 'b1', toolName: 'Bash', title: 'Bash: pnpm test' })];
    expect(sessionActivity(snapshot('idle', blocks)).running).toBe(0);
    expect(sessionActivity(snapshot('starting', blocks)).running).toBe(1);
    expect(sessionActivity(snapshot('stopping', blocks)).running).toBe(1);
  });

  it('does not repeat a block that a native task already stands for', () => {
    const view = sessionActivity(snapshot('running', [
      tool({ id: 'b1', toolName: 'Bash', title: 'Bash: pnpm dev', createdAt: at(1) }),
      tool({ id: 'b2', toolName: 'Bash', title: 'Bash: pnpm test', createdAt: at(2) }),
    ], [task({ id: 'native-1', title: 'pnpm dev', blockId: 'b1', background: true, startedAt: at(1) })]));
    expect(view.commands.map((item) => item.id)).toEqual(['task:native-1', 'block:b2']);
    expect(view.running).toBe(2);
  });
});

describe('sessionActivity: order and the finished cap', () => {
  it('puts running first with the oldest start first, then the finished with the latest end first', () => {
    const view = sessionActivity(snapshot('idle', [], [
      task({ id: 'finished-old', status: 'completed', startedAt: at(0), endedAt: at(5) }),
      task({ id: 'running-new', startedAt: at(9) }),
      task({ id: 'finished-new', status: 'failed', startedAt: at(1), endedAt: at(8) }),
      task({ id: 'running-old', startedAt: at(2) }),
    ]));
    expect(view.commands.map((item) => item.id)).toEqual(['task:running-old', 'task:running-new', 'task:finished-new', 'task:finished-old']);
  });

  it('keeps at most six finished items per group and never drops a running one', () => {
    const finished = Array.from({ length: 9 }, (_, index) => task({ id: `done-${index}`, status: 'completed', startedAt: at(index), endedAt: at(index + 1) }));
    const view = sessionActivity(snapshot('idle', [], [
      ...finished,
      task({ id: 'run-1', startedAt: at(20) }),
      task({ id: 'agent-done', kind: 'agent', status: 'completed', startedAt: at(0), endedAt: at(1) }),
    ]));
    expect(view.commands.map((item) => item.id)).toEqual(['task:run-1', 'task:done-8', 'task:done-7', 'task:done-6', 'task:done-5', 'task:done-4', 'task:done-3']);
    expect(view.agents).toHaveLength(1);
    expect(view.running).toBe(1);
  });

  it('counts running items over every group', () => {
    const view = sessionActivity(snapshot('running', [tool({ id: 'b1', toolName: 'Agent', title: 'Agent: Plan' })], [
      task({ id: 'c1' }),
      task({ id: 'c2', status: 'completed', endedAt: at(1) }),
      task({ id: 'o1', kind: 'task' }),
    ]));
    expect(view.running).toBe(3);
  });
});

describe('elapsedLabel', () => {
  it('reads minutes and seconds, then hours', () => {
    expect(elapsedLabel(0)).toBe('0:00');
    expect(elapsedLabel(999)).toBe('0:00');
    expect(elapsedLabel(42_000)).toBe('0:42');
    expect(elapsedLabel(59_999)).toBe('0:59');
    expect(elapsedLabel(60_000)).toBe('1:00');
    expect(elapsedLabel(12 * 60_000 + 5_000)).toBe('12:05');
    expect(elapsedLabel(3_599_000)).toBe('59:59');
    expect(elapsedLabel(3_600_000)).toBe('1:00:00');
    expect(elapsedLabel(3_723_000)).toBe('1:02:03');
    expect(elapsedLabel(26 * 3_600_000)).toBe('26:00:00');
  });

  it('reads 0:00 for a negative or unknown span', () => {
    expect(elapsedLabel(-1)).toBe('0:00');
    expect(elapsedLabel(Number.NaN)).toBe('0:00');
    expect(elapsedLabel(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});

describe('usageLine', () => {
  const item = (patch: Partial<ActivityItem>): ActivityItem => ({ id: 'x', kind: 'agent', title: 'x', status: 'running', background: false, ...patch });

  it('is empty when nothing is known', () => {
    expect(usageLine(item({}), 'en')).toBe('');
  });

  it('joins the detail, tool uses and tokens', () => {
    expect(usageLine(item({ detail: 'general-purpose', toolUses: 7, totalTokens: 18_400 }), 'en')).toBe('general-purpose · 7 tool uses · 18.4K tokens');
    expect(usageLine(item({ detail: 'Start the UI Lab' }), 'en')).toBe('Start the UI Lab');
    expect(usageLine(item({ totalTokens: 950 }), 'en')).toBe('950 tokens');
  });

  it('uses the singular form for one tool use in English', () => {
    expect(usageLine(item({ toolUses: 1 }), 'en')).toBe('1 tool use');
    expect(usageLine(item({ toolUses: 2 }), 'en')).toBe('2 tool uses');
  });

  it('declines tool uses in Russian', () => {
    expect(usageLine(item({ toolUses: 1 }), 'ru')).toBe('1 вызов');
    expect(usageLine(item({ toolUses: 2 }), 'ru')).toBe('2 вызова');
    expect(usageLine(item({ toolUses: 5 }), 'ru')).toBe('5 вызовов');
    expect(usageLine(item({ toolUses: 11 }), 'ru')).toBe('11 вызовов');
    expect(usageLine(item({ toolUses: 21 }), 'ru')).toBe('21 вызов');
    expect(usageLine(item({ detail: 'Explore', toolUses: 12, totalTokens: 950 }), 'ru')).toBe('Explore · 12 вызовов · 950 токенов');
  });
});

describe('observed block starts and ongoing work', () => {
  it('uses only an observed event start, ignoring createdAt', () => {
    const value = snapshot('running', [tool({id:'observed',toolName:'Bash',createdAt:at(-100)})]);
    expect(sessionActivity(value).commands[0]).not.toHaveProperty('startedAt');
    noteBlockStart('session-a','observed',BASE);
    expect(sessionActivity(value).commands[0]?.startedAt).toBe(BASE);
  });
  it('marks running native work and derived agents, but no quick commands or finished tasks', () => {
    const value = snapshot('running', [tool({id:'command',toolName:'Bash'}),tool({id:'agent',toolName:'Agent'})], [
      task({id:'native'}),task({id:'finished',kind:'agent',status:'completed'}),
    ]);
    expect(sessionActivity(value)).toMatchObject({running:3,ongoing:2});
  });
});

describe('token plurals', () => {
  const item = (totalTokens: number): ActivityItem => ({id:'t',kind:'agent',title:'t',status:'running',background:false,totalTokens});
  it('uses English token forms', () => {
    expect(usageLine(item(1),'en')).toBe('1 token');
    expect(usageLine(item(2),'en')).toBe('2 tokens');
    expect(usageLine(item(950),'en')).toBe('950 tokens');
    expect(usageLine(item(18400),'en')).toMatch(/tokens$/);
  });
  it('uses Russian token forms', () => {
    expect(usageLine(item(1),'ru')).toBe('1 токен');
    expect(usageLine(item(3),'ru')).toBe('3 токена');
    expect(usageLine(item(950),'ru')).toBe('950 токенов');
    expect(usageLine(item(18400),'ru')).toMatch(/токенов$/);
  });
});
