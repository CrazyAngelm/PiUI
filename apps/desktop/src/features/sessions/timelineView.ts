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

const timelineLabels: Record<TimelineBlock['kind'], string> = {
  user: 'You',
  assistant: 'Pi',
  thinking: 'Reasoning',
  tool: 'Tool activity',
  custom: 'Extension message',
  error: 'Runtime notice',
  compaction: 'Context compacted',
  unknown: 'Unsupported session event',
};

export function timelineBlockDisplayLabel(block: TimelineBlock, agentLabel: string): string {
  const sourceLabel = block.label ?? timelineLabels[block.kind];
  return block.kind === 'assistant' && agentLabel === 'Prime Agent' && sourceLabel === 'Pi'
    ? agentLabel
    : sourceLabel;
}

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

/** A finished reasoning block with nothing to show (no summary from the harness, redacted thinking). */
export function isSilentReasoning(block: TimelineBlock): boolean {
  return block.kind === 'thinking' && block.status !== 'streaming' && !(block.text ?? block.safeSummary ?? '').trim();
}

/**
 * The chat transcript's grouping. Only tool calls collapse; assistant prose and
 * reasoning with text stay visible between them, in their native order. Silent
 * reasoning next to a tool call stays inside that run, so a harness that sends
 * empty reasoning items does not cut every command into its own row. No block
 * is dropped, reordered or changed.
 */
export function groupTranscriptBlocks(blocks: readonly TimelineBlock[]): TimelineViewItem[] {
  const items: TimelineViewItem[] = [];
  let run: TimelineBlock[] = [];
  let lead: TimelineBlock[] = [];

  const flush = (): void => {
    if (run.length > 0) items.push(createActivityGroup(run));
    else for (const block of lead) items.push({ type: 'block', block });
    run = [];
    lead = [];
  };

  for (const block of blocks) {
    if (block.kind === 'tool') {
      if (run.length === 0 && lead.length > 0) {
        run = lead;
        lead = [];
      }
      run.push(block);
    } else if (isSilentReasoning(block)) {
      (run.length > 0 ? run : lead).push(block);
    } else {
      flush();
      items.push({ type: 'block', block });
    }
  }
  flush();
  return items;
}

function sameItem(known: TimelineViewItem, item: TimelineViewItem): boolean {
  if (known.type === 'block') return item.type === 'block' && known.block === item.block;
  return (
    item.type === 'activity-group' &&
    known.blocks.length === item.blocks.length &&
    known.blocks.every((block, index) => block === item.blocks[index])
  );
}

/**
 * `groupTranscriptBlocks` for a live transcript. An item whose blocks are the
 * same objects as on the previous call keeps its identity, so one streamed
 * token does not make every earlier activity group recompute its summary and
 * diff totals.
 */
export function createTimelineGrouper(): (blocks: readonly TimelineBlock[]) => TimelineViewItem[] {
  let previous = new Map<string, TimelineViewItem>();
  return (blocks) => {
    const next = new Map<string, TimelineViewItem>();
    const items = groupTranscriptBlocks(blocks).map((item) => {
      const key = item.type === 'block' ? `block:${item.block.id}` : item.id;
      const known = previous.get(key);
      const kept = known !== undefined && sameItem(known, item) ? known : item;
      next.set(key, kept);
      return kept;
    });
    previous = next;
    return items;
  };
}
