import { describe, expect, it } from 'vitest';
import type { TimelineBlock } from '../../host-api/types';
import {
  createTimelineGrouper,
  groupTimelineBlocks,
  groupTranscriptBlocks,
  isSilentReasoning,
  timelineBlockDisplayLabel,
  type TimelineTurnProcess,
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

/** Item shapes in order: `block:<id>` and `process[...]`, where a group is `(<ids>)` and a folded reply is its id. */
function shape(items: readonly TimelineViewItem[]): string[] {
  return items.map((item) => {
    if (item.type === 'block') return `block:${item.block.id}`;
    return `process[${item.parts.map((part) => (part.type === 'block' ? part.block.id : `(${part.blocks.map((entry) => entry.id).join('+')})`)).join(' ')}]`;
  });
}

/** Every block id in display order, whether it sits in the chat or inside a process. */
const flatten = (items: readonly TimelineViewItem[]): string[] =>
  items.flatMap((item) =>
    item.type === 'block' ? [item.block.id] : item.parts.flatMap((part) => (part.type === 'block' ? [part.block.id] : part.blocks.map((entry) => entry.id))),
  );

const processes = (items: readonly TimelineViewItem[]): TimelineTurnProcess[] =>
  items.filter((item): item is TimelineTurnProcess => item.type === 'turn-process');

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

    expect(shape(first)).toEqual(['block:user', 'process[(tool+thinking)]', 'block:answer']);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).not.toBe(first[2]);
    expect(second).toEqual(groupTranscriptBlocks([user, tool, thinking, grown]));
  });

  it('rebuilds a process when one of its blocks changes or a block joins it', () => {
    const group = createTimelineGrouper();
    const running = block('first', 'tool', 'streaming');
    const before = group([running]);
    const finished = { ...running, status: 'complete' as const };
    const after = group([finished]);

    expect(after[0]).not.toBe(before[0]);
    expect(processes(before)[0]).toMatchObject({ live: true });
    expect(processes(after)[0]).not.toHaveProperty('live');
    expect(processes(after)[0]?.parts[0]).toMatchObject({ status: 'complete', autoOpen: false });

    const second = block('second', 'tool');
    const joined = group([finished, second]);
    expect(joined[0]).not.toBe(after[0]);
    expect(processes(joined)[0]?.parts[0]).toMatchObject({ blocks: [finished, second] });
  });

  it('grows one process as reasoning and a tool call arrive, under the same ids', () => {
    const group = createTimelineGrouper();
    const thought = withText(block('thought', 'thinking', 'streaming'), 'a');
    const first = group([thought]);
    const tool = block('tool', 'tool', 'streaming');
    const second = group([thought, tool]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: 'turn-process', id: 'turn:thought' });
    expect(second[0]).toMatchObject({ type: 'turn-process', id: 'turn:thought', groups: 1 });
    expect(processes(second)[0]?.parts[0]).toMatchObject({ id: 'activity:thought', blocks: [thought, tool] });
    expect(second[0]).not.toBe(first[0]);
  });

  it('keeps the groups and replies of a growing process that did not change', () => {
    const group = createTimelineGrouper();
    const user = block('user', 'user');
    const a = block('a', 'tool');
    const note = withText(block('note', 'assistant'), 'Next');
    const b = block('b', 'tool', 'streaming');
    const grown = { ...b, text: 'more output' };

    const first = group([user, a, note, b], true);
    const second = group([user, a, note, grown], true);

    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    const before = processes(first)[0]!;
    const after = processes(second)[0]!;
    expect(after.parts[0]).toBe(before.parts[0]);
    expect(after.parts[1]).toBe(before.parts[1]);
    expect(after.parts[2]).not.toBe(before.parts[2]);
    expect(after.id).toBe(before.id);
  });

  it('rebuilds the working process once its turn finishes', () => {
    const group = createTimelineGrouper();
    const user = block('user', 'user');
    const a = block('a', 'tool', 'streaming');
    const note = withText(block('note', 'assistant'), 'Next');
    const b = block('b', 'tool');
    const done = { ...a, status: 'complete' as const };

    const working = group([user, a, note, b], true);
    expect(shape(working)).toEqual(['block:user', 'process[(a) note (b)]']);
    expect(processes(working)[0]).toMatchObject({ live: true });
    expect(processes(working)[0]?.parts[0]).not.toHaveProperty('live');
    expect(processes(working)[0]?.parts[2]).toMatchObject({ live: true });

    const finished = group([user, done, note, b, withText(block('answer', 'assistant'), 'Done')], false);
    expect(shape(finished)).toEqual(['block:user', 'process[(a) note (b)]', 'block:answer']);
    expect(finished[1]).not.toBe(working[1]);
    expect(processes(finished)[0]).not.toHaveProperty('live');
    expect(processes(finished)[0]?.parts[2]).not.toHaveProperty('live');
    expect(processes(finished)[0]?.parts[2]).not.toBe(processes(working)[0]?.parts[2]);
  });

  it('keeps a finished process while a later turn streams', () => {
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

    expect(shape(first)).toEqual(['block:user', 'process[(a) note (b)]', 'block:reply', 'block:next', 'block:stream']);
    for (let index = 0; index < 4; index += 1) expect(second[index]).toBe(first[index]);
    expect(second[4]).not.toBe(first[4]);
  });

  it('rebuilds a process whose duration changed, keeping the parts that did not', () => {
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
    expect(processes(slower)[0]?.parts[0]).toBe(processes(first)[0]?.parts[0]);
  });

  it('rebuilds the chat when a reply starts to carry a file', () => {
    const group = createTimelineGrouper();
    const user = block('user', 'user');
    const a = block('a', 'tool');
    const note = withText(block('note', 'assistant'), 'Here is the file');
    const b = block('b', 'tool');
    const answer = withText(block('answer', 'assistant'), 'Done');
    const input = [user, a, note, b, answer];

    const folded = group(input);
    const kept = group(input, false, (candidate) => candidate.id === 'note');

    expect(shape(folded)).toEqual(['block:user', 'process[(a) note (b)]', 'block:answer']);
    expect(shape(kept)).toEqual(['block:user', 'process[(a)]', 'block:note', 'process[(b)]', 'block:answer']);
  });
});

describe('groupTranscriptBlocks', () => {
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

      expect(shape(items)).toEqual(['block:user', 'process[(plan+a+b+next+d)]']);
      expect(processes(items)[0]?.parts[0]).toMatchObject({ type: 'activity-group', id: 'activity:plan', blocks: [plan, toolA, toolB, next, toolD] });
    });

    it('folds the reply between two runs of work into the process', () => {
      const toolA = block('a', 'tool');
      const toolC = block('c', 'tool');
      const thought = withText(block('next', 'thinking'), 'Next step');

      const items = groupTranscriptBlocks([user, toolA, reply('narration'), toolC, thought], true);

      expect(shape(items)).toEqual(['block:user', 'process[(a) narration (c+next)]']);
    });

    it('keeps a group made only of silent reasoning', () => {
      const silent = block('silent', 'thinking');
      const items = groupTranscriptBlocks([user, silent, reply('answer')]);

      expect(shape(items)).toEqual(['block:user', 'process[(silent)]', 'block:answer']);
    });

    it('lets silent reasoning join the run around it', () => {
      const toolA = block('a', 'tool');
      const silent = block('silent', 'thinking');
      const toolB = block('b', 'tool');

      expect(shape(groupTranscriptBlocks([toolA, silent, toolB]))).toEqual(['process[(a+silent+b)]']);
      expect(shape(groupTranscriptBlocks([silent, toolA]))).toEqual(['process[(silent+a)]']);
    });

    it('groups streaming reasoning with the tool calls next to it', () => {
      const toolA = block('a', 'tool');
      const streaming = block('live', 'thinking', 'streaming');

      expect(shape(groupTranscriptBlocks([toolA, streaming], true))).toEqual(['process[(a+live)]']);
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

      expect(shape(items)).toEqual(['process[(a)]', 'block:x', 'process[(b)]', 'block:e', 'process[(c)]', 'block:k', 'process[(d)]', 'block:u']);
      expect((items[1] as { block: TimelineBlock }).block).toBe(unknown);
      expect(unknown).toEqual(original);
    });

    it('treats a reply that only has a summary as a reply', () => {
      const summary = { ...block('answer', 'assistant'), safeSummary: 'Answered' };

      expect(shape(groupTranscriptBlocks([block('a', 'tool'), summary, block('b', 'tool')], true))).toEqual(['process[(a) answer (b)]']);
      expect(shape(groupTranscriptBlocks([block('a', 'tool'), summary]))).toEqual(['process[(a)]', 'block:answer']);
    });
  });

  describe('blocks with no text yet', () => {
    it('does not cut a group in two, and follows the group it waited behind', () => {
      const blank = block('blank', 'assistant', 'streaming');
      const done = block('done', 'assistant');

      expect(shape(groupTranscriptBlocks([block('a', 'tool'), blank, block('b', 'tool')], true))).toEqual(['process[(a+b)]', 'block:blank']);
      expect(shape(groupTranscriptBlocks([block('a', 'tool'), done, block('b', 'tool')]))).toEqual(['process[(a+b)]', 'block:done']);
    });

    it('folds with the work that follows it, and stays in place when none does', () => {
      const blank = block('blank', 'assistant', 'streaming');

      expect(shape(groupTranscriptBlocks([user, blank, block('a', 'tool')], true))).toEqual(['block:user', 'process[blank (a)]']);
      expect(shape(groupTranscriptBlocks([user, blank], true))).toEqual(['block:user', 'block:blank']);
    });

    it('separates when it failed or was stopped', () => {
      const failed = block('failed', 'assistant', 'failed');
      const stopped = block('stopped', 'assistant', 'interrupted');

      expect(shape(groupTranscriptBlocks([block('a', 'tool'), failed, block('b', 'tool')], true))).toEqual(['process[(a)]', 'block:failed', 'process[(b)]']);
      expect(shape(groupTranscriptBlocks([block('a', 'tool'), stopped, block('b', 'tool')], true))).toEqual(['process[(a)]', 'block:stopped', 'process[(b)]']);
    });
  });

  describe('process', () => {
    const turn = [
      at(user, '2026-01-01T10:00:00Z'),
      block('a', 'tool'),
      reply('note'),
      block('b', 'tool'),
      at(reply('answer'), '2026-01-01T10:01:05Z'),
    ];

    it('folds the work of a turn and the replies between its groups, and leaves the answer', () => {
      const items = groupTranscriptBlocks(turn);

      expect(shape(items)).toEqual(['block:user', 'process[(a) note (b)]', 'block:answer']);
      expect(items[1]).toMatchObject({
        type: 'turn-process',
        id: 'turn:a',
        blocks: [turn[1], turn[3]],
        groups: 2,
        startedAt: '2026-01-01T10:00:00Z',
        endedAt: '2026-01-01T10:01:05Z',
      });
      const process = processes(items)[0]!;
      expect(process.parts[1]).toMatchObject({ type: 'block', block: turn[2] });
      expect((process.parts[0] as { blocks: readonly TimelineBlock[] }).blocks[0]).toBe(turn[1]);
    });

    it('is one control for a single group, too', () => {
      const items = groupTranscriptBlocks([user, block('a', 'tool'), block('b', 'tool'), reply('answer')]);

      expect(shape(items)).toEqual(['block:user', 'process[(a+b)]', 'block:answer']);
      expect(processes(items)[0]).toMatchObject({ groups: 1 });
    });

    it('is not offered for a turn with no work', () => {
      expect(shape(groupTranscriptBlocks([user, reply('answer')]))).toEqual(['block:user', 'block:answer']);
    });

    it('folds a reply written before the first call', () => {
      const items = groupTranscriptBlocks([user, reply('plan'), block('a', 'tool'), reply('answer')]);

      expect(shape(items)).toEqual(['block:user', 'process[plan (a)]', 'block:answer']);
      expect(processes(items)[0]).toMatchObject({ id: 'turn:a', groups: 1 });
    });

    it('lists every tool and reasoning block of the process, in order', () => {
      const thought = withText(block('thought', 'thinking'), 'Plan');
      const input = [user, thought, block('a', 'tool'), reply('note'), block('silent', 'thinking'), block('b', 'tool'), reply('answer')];

      const process = processes(groupTranscriptBlocks(input))[0];

      expect(process).toMatchObject({ id: 'turn:thought', groups: 2 });
      expect(process?.blocks.map((entry) => entry.id)).toEqual(['thought', 'a', 'silent', 'b']);
    });

    it('keeps a finished turn\'s last reply in the chat even when a call was logged after it', () => {
      const input = [user, block('a', 'tool'), reply('answer'), block('b', 'tool')];

      expect(shape(groupTranscriptBlocks(input, false))).toEqual(['block:user', 'process[(a)]', 'block:answer', 'process[(b)]']);
      // While the turn works, the reply is a note between two runs.
      expect(shape(groupTranscriptBlocks([user, block('a', 'tool'), reply('answer'), block('b', 'tool', 'streaming')], true))).toEqual(['block:user', 'process[(a) answer (b)]']);
    });

    it('keeps the replies the owner asks to keep, and ends the process at them', () => {
      const input = [user, block('a', 'tool'), reply('note'), block('b', 'tool'), reply('answer')];

      const items = groupTranscriptBlocks(input, false, (candidate) => candidate.id === 'note');

      expect(shape(items)).toEqual(['block:user', 'process[(a)]', 'block:note', 'process[(b)]', 'block:answer']);
    });

    it('ends at a reply that failed or was stopped, so it stays visible', () => {
      const input = [user, block('a', 'tool'), reply('stopped', 'interrupted'), block('b', 'tool'), reply('answer')];

      expect(shape(groupTranscriptBlocks(input))).toEqual(['block:user', 'process[(a)]', 'block:stopped', 'process[(b)]', 'block:answer']);
    });

    it('treats the blocks before the first user message as a turn of their own', () => {
      const items = groupTranscriptBlocks([block('a', 'tool'), reply('note'), block('b', 'tool'), reply('lead'), user, reply('answer')]);

      expect(shape(items)).toEqual(['process[(a) note (b)]', 'block:lead', 'block:user', 'block:answer']);
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

    it('keeps the process id while later turns arrive', () => {
      const first = groupTranscriptBlocks(turn)[1];
      const later = groupTranscriptBlocks([...turn, block('next', 'user'), block('c', 'tool'), reply('more')])[1];

      expect(first).toMatchObject({ id: 'turn:a' });
      expect(later).toMatchObject({ id: 'turn:a' });
    });

    it('gives every turn its own process', () => {
      const next = block('next', 'user');
      const input = [user, block('a', 'tool'), reply('note'), block('b', 'tool'), reply('answer'), next, block('c', 'tool'), reply('more')];

      expect(shape(groupTranscriptBlocks(input))).toEqual(['block:user', 'process[(a) note (b)]', 'block:answer', 'block:next', 'process[(c)]', 'block:more']);
    });
  });

  describe('attention', () => {
    const wrapped = (last: TimelineBlock): TimelineBlock[] => [user, block('a', 'tool'), reply('note'), block('b', 'tool'), last];

    it('asks for the process of a turn that ended badly', () => {
      for (const last of [block('x', 'assistant', 'failed'), block('x', 'assistant', 'interrupted'), block('x', 'error'), block('x', 'tool', 'failed')]) {
        const items = groupTranscriptBlocks(wrapped(last));
        const list = processes(items);
        expect(list.length).toBeGreaterThan(0);
        expect(list[list.length - 1]).toMatchObject({ attention: true });
      }
    });

    it('marks only the last process of the turn', () => {
      const items = groupTranscriptBlocks([user, block('a', 'tool'), reply('stopped', 'interrupted'), block('b', 'tool'), block('x', 'error')]);

      expect(processes(items).map((entry) => entry.attention)).toEqual([undefined, true]);
    });

    it('leaves a turn that ended well alone, even after a failed call', () => {
      const items = groupTranscriptBlocks([user, block('a', 'tool', 'failed'), reply('note'), block('b', 'tool'), reply('answer')]);

      expect(shape(items)).toEqual(['block:user', 'process[(a) note (b)]', 'block:answer']);
      expect(processes(items)[0]).not.toHaveProperty('attention');
    });
  });

  describe('live', () => {
    it('marks the process and only its last group while the last turn works', () => {
      const input = [user, block('a', 'tool'), reply('note'), block('b', 'tool', 'streaming')];

      const items = groupTranscriptBlocks(input, true);
      const process = processes(items)[0]!;

      expect(shape(items)).toEqual(['block:user', 'process[(a) note (b)]']);
      expect(process).toMatchObject({ live: true });
      expect(process.parts[0]).not.toHaveProperty('live');
      expect(process.parts[2]).toMatchObject({ type: 'activity-group', live: true });
    });

    it('marks the process even when every call in it has finished and the chat still works', () => {
      expect(processes(groupTranscriptBlocks([user, block('a', 'tool')], true))[0]).toMatchObject({ live: true });
    });

    it('marks the process that waits behind a reply placeholder', () => {
      const items = groupTranscriptBlocks([user, block('a', 'tool', 'streaming'), block('blank', 'assistant', 'streaming')], true);

      expect(shape(items)).toEqual(['block:user', 'process[(a)]', 'block:blank']);
      expect(processes(items)[0]).toMatchObject({ live: true });
    });

    it('marks nothing once a reply follows the work, or when the turn finished', () => {
      expect(processes(groupTranscriptBlocks([user, block('a', 'tool'), reply('answer', 'streaming')], true))[0]).not.toHaveProperty('live');
      expect(processes(groupTranscriptBlocks([user, block('a', 'tool'), reply('answer')], false))[0]).not.toHaveProperty('live');
      expect(processes(groupTranscriptBlocks([user, block('a', 'tool')], false))[0]).not.toHaveProperty('live');
    });

    it('is live while a block of the last turn still streams, running or not', () => {
      const input = [user, block('a', 'tool'), reply('note'), block('b', 'tool', 'streaming')];

      expect(processes(groupTranscriptBlocks(input, false))[0]).toMatchObject({ live: true });
    });

    it('needs a streaming block when the owner cannot tell whether the agent works', () => {
      const waiting = [user, block('a', 'tool'), reply('note'), block('b', 'tool')];
      const streaming = [user, block('a', 'tool'), reply('note'), block('b', 'tool', 'streaming')];

      expect(processes(groupTranscriptBlocks(waiting, 'unknown'))[0]).not.toHaveProperty('live');
      expect(processes(groupTranscriptBlocks(streaming, 'unknown'))[0]).toMatchObject({ live: true });
    });

    it('never marks an earlier turn, even while the last one runs', () => {
      const next = block('next', 'user');
      const input = [user, block('a', 'tool'), reply('note'), block('b', 'tool'), reply('answer'), next, block('c', 'tool', 'streaming')];

      const items = groupTranscriptBlocks(input, true);

      expect(shape(items)).toEqual(['block:user', 'process[(a) note (b)]', 'block:answer', 'block:next', 'process[(c)]']);
      expect(processes(items).map((entry) => entry.live)).toEqual([undefined, true]);
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

  it('keeps the ids while a run grows', () => {
    const running = block('a', 'tool', 'streaming');
    const done = { ...running, status: 'complete' as const };

    const grown = processes(groupTranscriptBlocks([done, block('b', 'tool', 'streaming')]))[0];
    const first = processes(groupTranscriptBlocks([running]))[0];

    expect(grown).toMatchObject({ id: 'turn:a' });
    expect(grown?.parts[0]).toMatchObject({ id: 'activity:a' });
    expect(first).toMatchObject({ id: 'turn:a' });
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
