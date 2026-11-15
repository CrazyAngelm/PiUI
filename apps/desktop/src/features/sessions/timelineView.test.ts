import { describe, expect, it } from 'vitest';
import type { TimelineBlock } from '../../host-api/types';
import {
  createTimelineGrouper,
  groupTimelineBlocks,
  groupTranscriptBlocks,
  isSilentReasoning,
  timelineBlockDisplayLabel,
  type TimelineViewItem,
} from './timelineView';

function block(id: string, kind: TimelineBlock['kind'], status: TimelineBlock['status'] = 'complete'): TimelineBlock {
  return { id, kind, status };
}

const withText = (source: TimelineBlock, text: string): TimelineBlock => ({ ...source, text });

describe('groupTimelineBlocks', () => {
  it('relabels only the generic Prime assistant label and preserves explicit Pi labels', () => {
    const generic = block('assistant', 'assistant');
    const explicit = { ...generic, id: 'explicit', label: 'Pi · fake scenario' };
    expect(timelineBlockDisplayLabel(generic, 'Prime Agent')).toBe('Prime Agent');
    expect(timelineBlockDisplayLabel(explicit, 'Prime Agent')).toBe('Pi · fake scenario');
    expect(timelineBlockDisplayLabel(explicit, 'Pi')).toBe('Pi · fake scenario');
  });

  it('groups only consecutive tool and thinking blocks without changing their order', () => {
    const user = block('user', 'user');
    const thinking = block('thinking', 'thinking');
    const tool = block('tool', 'tool');
    const assistant = block('assistant', 'assistant');
    const nextTool = block('next-tool', 'tool');

    const items = groupTimelineBlocks([user, thinking, tool, assistant, nextTool]);

    expect(items.map((item) => item.type)).toEqual(['block', 'activity-group', 'block', 'activity-group']);
    expect(items[0]).toMatchObject({ type: 'block', block: user });
    expect(items[1]).toMatchObject({
      type: 'activity-group',
      id: 'activity:thinking',
      summary: '2 actions completed · 1 tool · 1 reasoning step',
      status: 'complete',
      autoOpen: false,
      blocks: [thinking, tool],
    });
    expect(items[2]).toMatchObject({ type: 'block', block: assistant });
    expect(items[3]).toMatchObject({ type: 'activity-group', blocks: [nextTool] });
  });

  it('opens a group when any contained activity is running, failed, or interrupted', () => {
    const items = groupTimelineBlocks([
      block('finished', 'tool'),
      block('broken', 'thinking', 'failed'),
      block('running', 'tool', 'streaming'),
      block('stopped', 'thinking', 'interrupted'),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'activity-group',
      summary: '4 actions · 2 tools · 2 reasoning steps',
      status: 'failed',
      autoOpen: true,
    });
  });

  it('keeps generic fallback and non-activity blocks separate for persisted and live projections', () => {
    const fallback = { ...block('persisted-extension', 'unknown'), fallback: true, safeSummary: 'Unsupported event' };
    const liveTool = { ...block('live:tool', 'tool'), createdAt: undefined, safeSummary: 'Working…' };
    const persistedTool = { ...block('persisted-tool', 'tool'), createdAt: '2025-01-01T12:00:00Z' };

    const items = groupTimelineBlocks([persistedTool, fallback, liveTool]);

    expect(items).toMatchObject([
      { type: 'activity-group', blocks: [persistedTool] },
      { type: 'block', block: fallback },
      { type: 'activity-group', blocks: [liveTool] },
    ]);
    expect(fallback).toEqual({ ...block('persisted-extension', 'unknown'), fallback: true, safeSummary: 'Unsupported event' });
  });
});

const at = (source: TimelineBlock, createdAt: string): TimelineBlock => ({ ...source, createdAt });

/** Item shapes in order: `block:<id>`, `group:<ids>` and `turn:<groups>`. */
function shape(items: readonly TimelineViewItem[]): string[] {
  return items.map((item) => {
    if (item.type === 'block') return `block:${item.block.id}`;
    if (item.type === 'turn-process') return `turn:${item.groups}`;
    return `group:${item.blocks.map((entry) => entry.id).join('+')}`;
  });
}

describe('createTimelineGrouper', () => {
  it('keeps the identity of items whose blocks did not change', () => {
    const group = createTimelineGrouper();
    const user = block('user', 'user');
    const tool = block('tool', 'tool');
    const thinking = block('thinking', 'thinking');
    const streaming = withText(block('answer', 'assistant', 'streaming'), 'more');
    const grown = { ...streaming, text: 'more and more' };

    const first = group([user, tool, thinking, streaming]);
    const second = group([user, tool, thinking, grown]);

    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).not.toBe(first[2]);
    expect(second).toEqual(groupTranscriptBlocks([user, tool, thinking, grown]));
  });

  it('rebuilds a group when one of its blocks changes or a block joins it', () => {
    const group = createTimelineGrouper();
    const running = block('first', 'tool', 'streaming');
    const before = group([running]);
    const finished = { ...running, status: 'complete' as const };
    const after = group([finished]);

    expect(after[0]).not.toBe(before[0]);
    expect(after[0]).toMatchObject({ status: 'complete', autoOpen: false });

    const second = block('second', 'tool');
    const joined = group([finished, second]);
    expect(joined[0]).not.toBe(after[0]);
    expect(joined[0]).toMatchObject({ blocks: [finished, second] });
  });

  it('grows one group as reasoning and a tool call arrive, under the same id', () => {
    const group = createTimelineGrouper();
    const thought = withText(block('thought', 'thinking', 'streaming'), 'a');
    const first = group([thought]);
    const tool = block('tool', 'tool', 'streaming');
    const second = group([thought, tool]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: 'activity-group', id: 'activity:thought' });
    expect(second[0]).toMatchObject({ type: 'activity-group', id: 'activity:thought', blocks: [thought, tool] });
    expect(second[0]).not.toBe(first[0]);
  });

  it('rebuilds the working group once its turn finishes, and folds the turn', () => {
    const group = createTimelineGrouper();
    const user = block('user', 'user');
    const a = block('a', 'tool', 'streaming');
    const note = withText(block('note', 'assistant'), 'Next');
    const b = block('b', 'tool');
    const done = { ...a, status: 'complete' as const };

    const open = group([user, a, note, b], true);
    expect(open[1]).toMatchObject({ type: 'activity-group' });
    expect(open[1]).not.toHaveProperty('live');
    expect(open[3]).toMatchObject({ type: 'activity-group', live: true });
    expect(open.some((item) => item.type === 'turn-process')).toBe(false);

    const closed = group([user, done, note, b], false);
    expect(shape(closed)).toEqual(['block:user', 'turn:2', 'group:a', 'block:note', 'group:b']);
    expect(closed[4]).not.toBe(open[3]);
    expect(closed[4]).toMatchObject({ turnId: 'turn:a' });
    expect(closed[4]).not.toHaveProperty('live');
  });

  it('keeps a finished turn control and its groups while a later turn streams', () => {
    const group = createTimelineGrouper();
    const user = block('user', 'user');
    const a = block('a', 'tool');
    const note = withText(block('note', 'assistant'), 'Next');
    const b = block('b', 'tool');
    const reply = withText(block('reply', 'assistant'), 'Done');
    const next = block('next', 'user');
    const streaming = withText(block('stream', 'assistant', 'streaming'), 'Hel');
    const grown = { ...streaming, text: 'Hello' };
    const earlier = [user, a, note, b, reply, next];

    const first = group([...earlier, streaming], true);
    const second = group([...earlier, grown], true);

    expect(shape(first)).toEqual(['block:user', 'turn:2', 'group:a', 'block:note', 'group:b', 'block:reply', 'block:next', 'block:stream']);
    for (let index = 0; index < 7; index += 1) expect(second[index]).toBe(first[index]);
    expect(second[7]).not.toBe(first[7]);
  });

  it('rebuilds a turn control whose duration or group count changed', () => {
    const group = createTimelineGrouper();
    const user = at(block('user', 'user'), '2026-01-01T10:00:00Z');
    const a = block('a', 'tool');
    const note = withText(block('note', 'assistant'), 'Next');
    const b = block('b', 'tool');
    const reply = at(withText(block('reply', 'assistant'), 'Done'), '2026-01-01T10:00:20Z');
    const later = at(withText(block('reply', 'assistant'), 'Done'), '2026-01-01T10:00:45Z');

    const first = group([user, a, note, b, reply]);
    const again = group([user, a, note, b, reply]);
    const slower = group([user, a, note, b, later]);

    expect(again[1]).toBe(first[1]);
    expect(slower[1]).not.toBe(first[1]);
    expect(slower[1]).toMatchObject({ type: 'turn-process', startedAt: '2026-01-01T10:00:00Z', endedAt: '2026-01-01T10:00:45Z' });
    expect(slower[2]).toBe(first[2]);
  });
});

describe('groupTranscriptBlocks', () => {
  const flatten = (items: readonly TimelineViewItem[]): string[] =>
    items.flatMap((item) => {
      if (item.type === 'block') return [item.block.id];
      if (item.type === 'turn-process') return [];
      return item.blocks.map((entry) => entry.id);
    });
  const user = block('user', 'user');
  const reply = (id: string, status: TimelineBlock['status'] = 'complete'): TimelineBlock => withText(block(id, 'assistant', status), `Text ${id}`);

  describe('groups', () => {
    it('keeps reasoning with text and tool calls in one group', () => {
      const plan = withText(block('plan', 'thinking'), 'Plan the fix');
      const toolA = block('a', 'tool');
      const toolB = block('b', 'tool');
      const next = withText(block('next', 'thinking', 'streaming'), 'Next step');
      const toolD = block('d', 'tool');

      const items = groupTranscriptBlocks([user, plan, toolA, toolB, next, toolD]);

      expect(shape(items)).toEqual(['block:user', 'group:plan+a+b+next+d']);
      expect(items[1]).toMatchObject({ type: 'activity-group', id: 'activity:plan', blocks: [plan, toolA, toolB, next, toolD] });
    });

    it('splits groups at every reply', () => {
      const toolA = block('a', 'tool');
      const toolC = block('c', 'tool');
      const thought = withText(block('next', 'thinking'), 'Next step');

      const items = groupTranscriptBlocks([user, toolA, reply('answer'), toolC, thought], true);

      expect(shape(items)).toEqual(['block:user', 'group:a', 'block:answer', 'group:c+next']);
    });

    it('keeps a group made only of silent reasoning', () => {
      const silent = block('silent', 'thinking');
      const items = groupTranscriptBlocks([user, silent, reply('answer')]);

      expect(shape(items)).toEqual(['block:user', 'group:silent', 'block:answer']);
    });

    it('lets silent reasoning join the run around it', () => {
      const toolA = block('a', 'tool');
      const silent = block('silent', 'thinking');
      const toolB = block('b', 'tool');

      expect(shape(groupTranscriptBlocks([toolA, silent, toolB]))).toEqual(['group:a+silent+b']);
      expect(shape(groupTranscriptBlocks([silent, toolA]))).toEqual(['group:silent+a']);
    });

    it('groups streaming reasoning with the tool calls next to it', () => {
      const toolA = block('a', 'tool');
      const streaming = block('live', 'thinking', 'streaming');

      expect(shape(groupTranscriptBlocks([toolA, streaming], true))).toEqual(['group:a+live']);
    });

    it('calls whitespace silent and a summary, a status or a tool not silent', () => {
      expect(isSilentReasoning({ ...block('t', 'thinking'), text: '  \n' })).toBe(true);
      expect(isSilentReasoning({ ...block('t', 'thinking'), safeSummary: 'Planned the fix' })).toBe(false);
      expect(isSilentReasoning({ ...block('t', 'thinking', 'interrupted'), text: 'x' })).toBe(false);
      expect(isSilentReasoning(block('t', 'tool'))).toBe(false);
    });

    it('leaves fallback blocks, notices, compaction and custom blocks visible and untouched', () => {
      const toolA = block('a', 'tool');
      const unknown = { ...block('x', 'unknown'), fallback: true, safeSummary: 'Unsupported event' };
      const original = structuredClone(unknown);
      const toolB = block('b', 'tool');
      const error = block('e', 'error');
      const toolC = block('c', 'tool');
      const compaction = block('k', 'compaction');
      const toolD = block('d', 'tool');
      const custom = block('u', 'custom');

      const items = groupTranscriptBlocks([toolA, unknown, toolB, error, toolC, compaction, toolD, custom], true);

      expect(shape(items)).toEqual(['group:a', 'block:x', 'group:b', 'block:e', 'group:c', 'block:k', 'group:d', 'block:u']);
      expect((items[1] as { block: TimelineBlock }).block).toBe(unknown);
      expect(unknown).toEqual(original);
    });

    it('treats a reply that only has a summary as a reply', () => {
      const summary = { ...block('answer', 'assistant'), safeSummary: 'Answered' };
      expect(shape(groupTranscriptBlocks([block('a', 'tool'), summary, block('b', 'tool')], true))).toEqual(['group:a', 'block:answer', 'group:b']);
    });
  });

  describe('blocks with no text yet', () => {
    it('does not cut a group in two, and follows the group it waited behind', () => {
      const blank = block('blank', 'assistant', 'streaming');
      const done = block('done', 'assistant');

      expect(shape(groupTranscriptBlocks([block('a', 'tool'), blank, block('b', 'tool')], true))).toEqual(['group:a+b', 'block:blank']);
      expect(shape(groupTranscriptBlocks([block('a', 'tool'), done, block('b', 'tool')]))).toEqual(['group:a+b', 'block:done']);
    });

    it('stays in place when no group is open', () => {
      const blank = block('blank', 'assistant', 'streaming');

      expect(shape(groupTranscriptBlocks([user, blank, block('a', 'tool')], true))).toEqual(['block:user', 'block:blank', 'group:a']);
      expect(shape(groupTranscriptBlocks([user, blank], true))).toEqual(['block:user', 'block:blank']);
    });

    it('separates when it failed or was stopped', () => {
      const failed = block('failed', 'assistant', 'failed');
      const stopped = block('stopped', 'assistant', 'interrupted');

      expect(shape(groupTranscriptBlocks([block('a', 'tool'), failed, block('b', 'tool')], true))).toEqual(['group:a', 'block:failed', 'group:b']);
      expect(shape(groupTranscriptBlocks([block('a', 'tool'), stopped, block('b', 'tool')], true))).toEqual(['group:a', 'block:stopped', 'group:b']);
    });
  });

  describe('turn control', () => {
    const closedTurn = [
      at(user, '2026-01-01T10:00:00Z'),
      block('a', 'tool'),
      reply('note'),
      block('b', 'tool'),
      at(reply('answer'), '2026-01-01T10:01:05Z'),
    ];

    it('folds a finished turn with two or more groups behind one control placed before its first group', () => {
      const items = groupTranscriptBlocks(closedTurn);

      expect(shape(items)).toEqual(['block:user', 'turn:2', 'group:a', 'block:note', 'group:b', 'block:answer']);
      expect(items[1]).toEqual({
        type: 'turn-process',
        id: 'turn:a',
        blocks: [closedTurn[1], closedTurn[3]],
        groups: 2,
        startedAt: '2026-01-01T10:00:00Z',
        endedAt: '2026-01-01T10:01:05Z',
      });
      expect(items[2]).toMatchObject({ turnId: 'turn:a' });
      expect(items[4]).toMatchObject({ turnId: 'turn:a' });
      expect((items[2] as { blocks: readonly TimelineBlock[] }).blocks[0]).toBe(closedTurn[1]);
    });

    it('lists every tool and reasoning block of the turn, in order', () => {
      const thought = withText(block('thought', 'thinking'), 'Plan');
      const input = [user, thought, block('a', 'tool'), reply('note'), block('silent', 'thinking'), block('b', 'tool'), reply('answer')];

      const control = groupTranscriptBlocks(input).find((item) => item.type === 'turn-process');

      expect(control).toMatchObject({ id: 'turn:thought', groups: 2 });
      expect(control?.type === 'turn-process' && control.blocks.map((entry) => entry.id)).toEqual(['thought', 'a', 'silent', 'b']);
    });

    it('is not offered for a single group', () => {
      const items = groupTranscriptBlocks([user, block('a', 'tool'), block('b', 'tool'), reply('answer')]);

      expect(items.some((item) => item.type === 'turn-process')).toBe(false);
      expect(items[1]).not.toHaveProperty('turnId');
    });

    it('is not offered for a turn that ended badly', () => {
      const failed = (last: TimelineBlock): TimelineBlock[] => [user, block('a', 'tool'), reply('note'), block('b', 'tool'), last];

      for (const last of [block('x', 'assistant', 'failed'), block('x', 'assistant', 'interrupted'), block('x', 'error'), block('x', 'tool', 'failed')]) {
        const items = groupTranscriptBlocks(failed(last));
        expect(items.some((item) => item.type === 'turn-process')).toBe(false);
        for (const item of items) if (item.type === 'activity-group') expect(item.turnId).toBeUndefined();
      }
    });

    it('still folds a turn whose failed call is not the last thing that happened', () => {
      const input = [user, block('a', 'tool', 'failed'), reply('note'), block('b', 'tool'), reply('answer')];

      expect(shape(groupTranscriptBlocks(input))).toEqual(['block:user', 'turn:2', 'group:a', 'block:note', 'group:b', 'block:answer']);
    });

    it('is not offered while the last turn is running, and is once the chat stops', () => {
      const wrapped = [user, block('a', 'tool'), reply('note'), block('b', 'tool'), reply('answer')];

      expect(groupTranscriptBlocks(wrapped, true).some((item) => item.type === 'turn-process')).toBe(false);
      expect(groupTranscriptBlocks(wrapped, false).some((item) => item.type === 'turn-process')).toBe(true);
    });

    it('is not offered while a block of the last turn still streams, running or not', () => {
      const input = [user, block('a', 'tool'), reply('note'), block('b', 'tool', 'streaming')];

      expect(groupTranscriptBlocks(input, false).some((item) => item.type === 'turn-process')).toBe(false);
    });

    it('keeps the last turn open, without a live group, when the owner cannot tell whether the agent works', () => {
      const wrapped = [user, block('a', 'tool'), reply('note'), block('b', 'tool'), reply('answer')];
      const waiting = [user, block('a', 'tool'), reply('note'), block('b', 'tool')];
      const streaming = [user, block('a', 'tool'), reply('note'), block('b', 'tool', 'streaming')];

      expect(groupTranscriptBlocks(wrapped, 'unknown').some((item) => item.type === 'turn-process')).toBe(false);
      for (const item of groupTranscriptBlocks(waiting, 'unknown')) expect(item).not.toMatchObject({ live: true });
      const live = groupTranscriptBlocks(streaming, 'unknown');
      expect(live[live.length - 1]).toMatchObject({ live: true });
      // An earlier turn is finished whatever the owner knows.
      const earlier = groupTranscriptBlocks([...wrapped, block('next', 'user'), reply('later')], 'unknown');
      expect(earlier.some((item) => item.type === 'turn-process')).toBe(true);
    });

    it('folds an earlier turn even while the last one runs', () => {
      const next = block('next', 'user');
      const input = [user, block('a', 'tool'), reply('note'), block('b', 'tool'), reply('answer'), next, block('c', 'tool', 'streaming')];

      const items = groupTranscriptBlocks(input, true);

      expect(shape(items)).toEqual(['block:user', 'turn:2', 'group:a', 'block:note', 'group:b', 'block:answer', 'block:next', 'group:c']);
      expect(items[7]).toMatchObject({ live: true });
      expect(items[7]).not.toHaveProperty('turnId');
    });

    it('treats the blocks before the first user message as a turn of their own', () => {
      const items = groupTranscriptBlocks([block('a', 'tool'), reply('note'), block('b', 'tool'), user, reply('answer')]);

      expect(shape(items)).toEqual(['turn:2', 'group:a', 'block:note', 'group:b', 'block:user', 'block:answer']);
      expect(items[0]).not.toHaveProperty('startedAt');
      expect(items[0]).not.toHaveProperty('endedAt');
    });

    it('carries a duration only when both ends are known', () => {
      const noEnd = [at(user, '2026-01-01T10:00:00Z'), block('a', 'tool'), reply('note'), block('b', 'tool'), reply('answer')];
      const noStart = [user, block('a', 'tool'), reply('note'), block('b', 'tool'), at(reply('answer'), '2026-01-01T10:00:20Z')];

      for (const input of [noEnd, noStart]) {
        const control = groupTranscriptBlocks(input)[1];
        expect(control).toMatchObject({ type: 'turn-process' });
        expect(control).not.toHaveProperty('startedAt');
        expect(control).not.toHaveProperty('endedAt');
      }
    });

    it('keeps the control id while later turns arrive', () => {
      const first = groupTranscriptBlocks(closedTurn)[1];
      const later = groupTranscriptBlocks([...closedTurn, block('next', 'user'), block('c', 'tool'), reply('more')])[1];

      expect(first).toMatchObject({ id: 'turn:a' });
      expect(later).toMatchObject({ id: 'turn:a' });
    });
  });

  describe('live group', () => {
    it('marks only the group that is still open when the last turn has not finished', () => {
      const input = [user, block('a', 'tool'), reply('note'), block('b', 'tool', 'streaming')];

      const items = groupTranscriptBlocks(input, true);

      expect(items[1]).not.toHaveProperty('live');
      expect(items[3]).toMatchObject({ type: 'activity-group', live: true });
    });

    it('marks the group even when every call in it has finished and the chat still works', () => {
      const items = groupTranscriptBlocks([user, block('a', 'tool')], true);

      expect(items[1]).toMatchObject({ live: true });
    });

    it('marks the group that waits behind a reply placeholder', () => {
      const items = groupTranscriptBlocks([user, block('a', 'tool', 'streaming'), block('blank', 'assistant', 'streaming')], true);

      expect(shape(items)).toEqual(['block:user', 'group:a', 'block:blank']);
      expect(items[1]).toMatchObject({ live: true });
    });

    it('marks nothing once a reply follows the group, or when the turn finished', () => {
      expect(groupTranscriptBlocks([user, block('a', 'tool'), reply('answer', 'streaming')], true)[1]).not.toHaveProperty('live');
      expect(groupTranscriptBlocks([user, block('a', 'tool'), reply('answer')], false)[1]).not.toHaveProperty('live');
      expect(groupTranscriptBlocks([user, block('a', 'tool')], false)[1]).not.toHaveProperty('live');
    });
  });

  it('drops and reorders nothing', () => {
    const input = [
      block('user', 'user'),
      block('quiet-1', 'thinking'),
      withText(block('plan', 'thinking'), 'Plan'),
      block('a', 'tool'),
      block('b', 'tool'),
      block('quiet-2', 'thinking'),
      block('blank', 'assistant', 'streaming'),
      block('c', 'tool'),
      reply('answer'),
      withText(block('next', 'thinking'), 'Next'),
      block('d', 'tool'),
      block('again', 'user'),
      block('e', 'tool'),
      reply('last'),
    ];

    // Only a reply placeholder moves: it follows the group it waited behind.
    const expected = ['user', 'quiet-1', 'plan', 'a', 'b', 'quiet-2', 'c', 'blank', 'answer', 'next', 'd', 'again', 'e', 'last'];
    for (const running of [false, true]) expect(flatten(groupTranscriptBlocks(input, running))).toEqual(expected);
  });

  it('keeps the group id while a run grows', () => {
    const running = block('a', 'tool', 'streaming');
    const done = { ...running, status: 'complete' as const };

    expect(groupTranscriptBlocks([done, block('b', 'tool', 'streaming')])[0]).toMatchObject({ id: 'activity:a' });
    expect(groupTranscriptBlocks([running])[0]).toMatchObject({ id: 'activity:a' });
  });

  it('does not change its input', () => {
    const input = Object.freeze([
      Object.freeze(block('user', 'user')),
      Object.freeze(block('a', 'tool')),
      Object.freeze(block('silent', 'thinking')),
      Object.freeze(reply('note')),
      Object.freeze(withText(block('plan', 'thinking'), 'Plan')),
      Object.freeze(block('b', 'tool')),
      Object.freeze(reply('answer')),
    ]);

    expect(() => groupTranscriptBlocks(input)).not.toThrow();
    expect(input.map((entry) => entry.id)).toEqual(['user', 'a', 'silent', 'note', 'plan', 'b', 'answer']);
  });
});
