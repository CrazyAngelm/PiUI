import type { TimelineBlock } from '../../host-api/types';

export interface TimelineBlockItem {
  type: 'block';
  block: TimelineBlock;
}

export interface TimelineActivityGroup {
  type: 'activity-group';
  /** Stable from the first contained block so live updates retain disclosure state. */
  id: string;
  blocks: readonly TimelineBlock[];
  summary: string;
  status: TimelineBlock['status'];
  /** Running and terminal-problem activity must not be hidden by default. */
  autoOpen: boolean;
}

export type TimelineViewItem = TimelineBlockItem | TimelineActivityGroup;

function isActivityBlock(block: TimelineBlock): boolean {
  return block.kind === 'tool' || block.kind === 'thinking';
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function activityBlockTitle(block: TimelineBlock): string {
  if (block.kind === 'thinking') return block.label ?? 'Reasoning';
  return block.title ?? block.toolName ?? block.label ?? 'Tool activity';
}

export function activityStatusLabel(status: TimelineBlock['status']): string | undefined {
  switch (status) {
    case 'streaming': return 'Running';
    case 'failed': return 'Failed';
    case 'interrupted': return 'Stopped';
    case 'complete': return undefined;
  }
}

export function shouldAutoOpenActivity(status: TimelineBlock['status']): boolean {
  return status === 'streaming' || status === 'failed' || status === 'interrupted';
}

function groupStatus(blocks: readonly TimelineBlock[]): TimelineBlock['status'] {
  if (blocks.some((block) => block.status === 'failed')) return 'failed';
  if (blocks.some((block) => block.status === 'interrupted')) return 'interrupted';
  if (blocks.some((block) => block.status === 'streaming')) return 'streaming';
  return 'complete';
}

function groupSummary(blocks: readonly TimelineBlock[], status: TimelineBlock['status']): string {
  if (blocks.length === 1) return activityBlockTitle(blocks[0]!);

  const tools = blocks.filter((block) => block.kind === 'tool').length;
  const thinking = blocks.length - tools;
  const parts: string[] = [countLabel(blocks.length, 'action', 'actions')];
  if (tools > 0) parts.push(countLabel(tools, 'tool', 'tools'));
  if (thinking > 0) parts.push(countLabel(thinking, 'reasoning step', 'reasoning steps'));
  if (status === 'complete') parts[0] = `${parts[0]} completed`;
  return parts.join(' · ');
}

function createActivityGroup(blocks: readonly TimelineBlock[]): TimelineActivityGroup {
  const status = groupStatus(blocks);
  return {
    type: 'activity-group',
    id: `activity:${blocks[0]!.id}`,
    blocks,
    summary: groupSummary(blocks, status),
    status,
    autoOpen: blocks.some((block) => shouldAutoOpenActivity(block.status)),
  };
}

/**
 * Converts the flat host projection into display items without reordering,
 * changing, or interpreting its payload. Only adjacent built-in activity
 * blocks share a disclosure; generic/fallback blocks always remain visible as
 * their own compatible renderer.
 */
export function groupTimelineBlocks(blocks: readonly TimelineBlock[]): TimelineViewItem[] {
  const items: TimelineViewItem[] = [];
  let activityBlocks: TimelineBlock[] = [];

  const flushActivity = (): void => {
    if (activityBlocks.length > 0) items.push(createActivityGroup(activityBlocks));
    activityBlocks = [];
  };

  for (const block of blocks) {
    if (isActivityBlock(block)) {
      activityBlocks.push(block);
      continue;
    }
    flushActivity();
    items.push({ type: 'block', block });
  }
  flushActivity();

  return items;
}
