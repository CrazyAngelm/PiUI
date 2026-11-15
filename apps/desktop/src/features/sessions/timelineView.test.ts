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

describe('createTimelineGrouper', () => {
  it('keeps the identity of items whose blocks did not change', () => {
    const group = createTimelineGrouper();
    const tool = block('tool', 'tool');
    const thinking = block('thinking', 'thinking');
    const streaming = block('answer', 'assistant', 'streaming');
    const grown = { ...streaming, text: 'more' };

    const first = group([tool, thinking, streaming]);
    const second = group([tool, thinking, grown]);

    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second).toEqual(groupTranscriptBlocks([tool, thinking, grown]));
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

  it('keeps a streaming reasoning row when a tool call starts after it', () => {
    const group = createTimelineGrouper();
    const thought = withText(block('thought', 'thinking', 'streaming'), 'a');
    const first = group([thought]);
    const second = group([thought, block('tool', 'tool', 'streaming')]);

    expect(first[0]).toMatchObject({ type: 'block', block: thought });
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toMatchObject({ type: 'activity-group' });
  });
});

describe('groupTranscriptBlocks', () => {
  const flatten = (items: readonly TimelineViewItem[]): string[] =>
    items.flatMap((item) => (item.type === 'block' ? [item.block.id] : item.blocks.map((entry) => entry.id)));

  it('lets prose and reasoning split tool runs', () => {
    const user = block('user', 'user');
    const plan = withText(block('plan', 'thinking'), 'Plan the fix');
    const toolA = block('a', 'tool');
    const toolB = block('b', 'tool');
    const assistant = withText(block('answer', 'assistant'), 'Looking');
    const toolC = block('c', 'tool');
    const next = withText(block('next', 'thinking'), 'Next step');
    const toolD = block('d', 'tool');

    const items = groupTranscriptBlocks([user, plan, toolA, toolB, assistant, toolC, next, toolD]);

    expect(items.map((item) => item.type)).toEqual([
      'block', 'block', 'activity-group', 'block', 'activity-group', 'block', 'activity-group',
    ]);
    expect(items[1]).toMatchObject({ type: 'block' });
    expect((items[1] as { block: TimelineBlock }).block).toBe(plan);
    expect((items[5] as { block: TimelineBlock }).block).toBe(next);
    expect(items[2]).toMatchObject({ blocks: [toolA, toolB] });
    expect(items[4]).toMatchObject({ blocks: [toolC] });
    expect(items[6]).toMatchObject({ blocks: [toolD] });
  });

  it('keeps silent reasoning between tool calls inside the run', () => {
    const toolA = block('a', 'tool');
    const silent = block('silent', 'thinking');
    const toolB = block('b', 'tool');

    const items = groupTranscriptBlocks([toolA, silent, toolB]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'activity-group', blocks: [toolA, silent, toolB] });
  });

  it('lets leading silent reasoning join the run that follows', () => {
    const silent = block('silent', 'thinking');
    const toolA = block('a', 'tool');

    const items = groupTranscriptBlocks([silent, toolA]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'activity-group', id: 'activity:silent', blocks: [silent, toolA] });
  });

  it('keeps silent reasoning without an adjacent tool call as its own block', () => {
    const items = groupTranscriptBlocks([block('user', 'user'), block('silent', 'thinking'), block('answer', 'assistant')]);

    expect(items.map((item) => item.type)).toEqual(['block', 'block', 'block']);
    expect(flatten(items)).toEqual(['user', 'silent', 'answer']);
  });

  it('never treats streaming reasoning as silent', () => {
    const toolA = block('a', 'tool');
    const streaming = block('live', 'thinking', 'streaming');

    const items = groupTranscriptBlocks([toolA, streaming]);

    expect(items.map((item) => item.type)).toEqual(['activity-group', 'block']);
    expect(items[0]).toMatchObject({ blocks: [toolA] });
    expect((items[1] as { block: TimelineBlock }).block).toBe(streaming);
  });

  it('calls whitespace silent and a summary, a status or a tool not silent', () => {
    expect(isSilentReasoning({ ...block('t', 'thinking'), text: '  \n' })).toBe(true);
    expect(isSilentReasoning({ ...block('t', 'thinking'), safeSummary: 'Planned the fix' })).toBe(false);
    expect(isSilentReasoning({ ...block('t', 'thinking', 'interrupted'), text: 'x' })).toBe(false);
    expect(isSilentReasoning(block('t', 'tool'))).toBe(false);
  });

  it('leaves fallback blocks and notices untouched', () => {
    const toolA = block('a', 'tool');
    const unknown = { ...block('x', 'unknown'), fallback: true, safeSummary: 'Unsupported event' };
    const original = structuredClone(unknown);
    const toolB = block('b', 'tool');
    const error = block('e', 'error');
    const toolC = block('c', 'tool');
    const compaction = block('k', 'compaction');

    const items = groupTranscriptBlocks([toolA, unknown, toolB, error, toolC, compaction]);

    expect(items.map((item) => item.type)).toEqual([
      'activity-group', 'block', 'activity-group', 'block', 'activity-group', 'block',
    ]);
    expect((items[1] as { block: TimelineBlock }).block).toBe(unknown);
    expect(unknown).toEqual(original);
  });

  it('drops and reorders nothing', () => {
    const input = [
      block('user', 'user'),
      block('quiet-1', 'thinking'),
      withText(block('plan', 'thinking'), 'Plan'),
      block('a', 'tool'),
      block('b', 'tool'),
      block('quiet-2', 'thinking'),
      block('answer', 'assistant'),
      block('c', 'tool'),
      withText(block('next', 'thinking'), 'Next'),
      block('d', 'tool'),
    ];

    expect(flatten(groupTranscriptBlocks(input))).toEqual(input.map((entry) => entry.id));
  });

  it('keeps the group id while a run grows', () => {
    const running = block('a', 'tool', 'streaming');
    const done = { ...running, status: 'complete' as const };

    expect(groupTranscriptBlocks([done, block('b', 'tool', 'streaming')])[0]).toMatchObject({ id: 'activity:a' });
    expect(groupTranscriptBlocks([running])[0]).toMatchObject({ id: 'activity:a' });
  });

  it('does not change its input', () => {
    const input = Object.freeze([
      Object.freeze(block('a', 'tool')),
      Object.freeze(block('silent', 'thinking')),
      Object.freeze(withText(block('plan', 'thinking'), 'Plan')),
      Object.freeze(block('b', 'tool')),
    ]);

    expect(() => groupTranscriptBlocks(input)).not.toThrow();
    expect(input.map((entry) => entry.id)).toEqual(['a', 'silent', 'plan', 'b']);
  });
});
