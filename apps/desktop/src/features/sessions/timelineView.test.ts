import { describe, expect, it } from 'vitest';
import type { TimelineBlock } from '../../host-api/types';
import { createTimelineGrouper, groupTimelineBlocks, timelineBlockDisplayLabel } from './timelineView';

function block(id: string, kind: TimelineBlock['kind'], status: TimelineBlock['status'] = 'complete'): TimelineBlock {
  return { id, kind, status };
}

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
    expect(second).toEqual(groupTimelineBlocks([tool, thinking, grown]));
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
});
