import { describe, expect, it } from 'vitest';
import type { TimelineBlock } from '../../host-api/types';
import { groupTimelineBlocks } from './timelineView';

function block(id: string, kind: TimelineBlock['kind'], status: TimelineBlock['status'] = 'complete'): TimelineBlock {
  return { id, kind, status };
}

describe('groupTimelineBlocks', () => {
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
