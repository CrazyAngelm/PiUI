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
  /** The turn control that hides this group while it is closed. */
  turnId?: string;
  /** Still working: the last group of a turn that has not finished. */
  live?: boolean;
}

/**
 * One control that folds every tool and reasoning group of a finished turn.
 * Replies stay visible; the groups appear when the control is opened.
 */
export interface TimelineTurnProcess {
  type: 'turn-process';
  /** `turn:<id of the turn's first process block>`: stable while later turns arrive. */
  id: string;
  /** Every tool and reasoning block of the turn, in order (the same objects as in its groups). */
  blocks: readonly TimelineBlock[];
  groups: number;
  /** `createdAt` of the user block that opens the turn and of the turn's last block, when both exist. */
  startedAt?: string;
  endedAt?: string;
}

/** What the catalog view (`groupTimelineBlocks`) produces: it has no turns. */
export type TimelineCatalogItem = TimelineBlockItem | TimelineActivityGroup;

export type TimelineViewItem = TimelineCatalogItem | TimelineTurnProcess;

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
export function groupTimelineBlocks(blocks: readonly TimelineBlock[]): TimelineCatalogItem[] {
  const items: TimelineCatalogItem[] = [];
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
 * An assistant block with no text yet (the placeholder a harness opens before
 * it streams): it separates nothing, so it must not cut a group in two.
 */
function isTransparent(block: TimelineBlock): boolean {
  return (
    block.kind === 'assistant' &&
    (block.status === 'complete' || block.status === 'streaming') &&
    !(block.text ?? '').trim() &&
    !(block.safeSummary ?? '').trim()
  );
}

/** A turn starts at each user block; blocks before the first one form a leading turn. */
function splitTurns(blocks: readonly TimelineBlock[]): TimelineBlock[][] {
  const turns: TimelineBlock[][] = [];
  for (const block of blocks) {
    if (block.kind === 'user' || turns.length === 0) turns.push([]);
    turns[turns.length - 1]!.push(block);
  }
  return turns;
}

function isProblemTurn(turn: readonly TimelineBlock[]): boolean {
  for (let index = turn.length - 1; index >= 0; index -= 1) {
    const block = turn[index]!;
    if (block.kind === 'user') continue;
    return block.kind === 'error' || block.status === 'failed' || block.status === 'interrupted';
  }
  return false;
}

/**
 * The chat transcript's grouping. Every adjacent tool and reasoning block (with
 * or without text) between two replies is one activity group. Replies, errors
 * and every other block stay visible as their own items, in their native
 * order; an assistant block with no text yet does not cut a group. A finished
 * turn with two or more groups also gets one `turn-process` control before its
 * first group, which folds all of them. No block is dropped, reordered or
 * changed.
 */
export function groupTranscriptBlocks(blocks: readonly TimelineBlock[], running: boolean | 'unknown' = false): TimelineViewItem[] {
  const turns = splitTurns(blocks);
  const items: TimelineViewItem[] = [];

  turns.forEach((turn, turnIndex) => {
    const last = turnIndex === turns.length - 1;
    // 'unknown': the owner cannot tell whether the agent still works. The last turn then stays open,
    // and only a streaming block makes its trailing group live.
    const streaming = turn.some((block) => block.status === 'streaming');
    const closed = !last || (running === false && !streaming);
    const turnItems: TimelineViewItem[] = [];
    const groups: TimelineActivityGroup[] = [];
    const process: TimelineBlock[] = [];
    let run: TimelineBlock[] = [];
    let held: TimelineBlock[] = [];

    const flush = (): TimelineActivityGroup | undefined => {
      if (run.length === 0) return undefined;
      const group = createActivityGroup(run);
      groups.push(group);
      turnItems.push(group);
      for (const block of held) turnItems.push({ type: 'block', block });
      run = [];
      held = [];
      return group;
    };

    for (const block of turn) {
      if (isActivityBlock(block)) {
        run.push(block);
        process.push(block);
      } else if (isTransparent(block)) {
        if (run.length > 0) held.push(block);
        else turnItems.push({ type: 'block', block });
      } else {
        flush();
        turnItems.push({ type: 'block', block });
      }
    }
    // The group still open when the turn's blocks end is the one at work.
    const trailing = flush();
    if (trailing && last && (running === true || streaming)) trailing.live = true;

    if (closed && groups.length >= 2 && !isProblemTurn(turn)) {
      const turnId = `turn:${process[0]!.id}`;
      for (const group of groups) group.turnId = turnId;
      const startedAt = turn[0]!.kind === 'user' ? turn[0]!.createdAt : undefined;
      const endedAt = turn[turn.length - 1]!.createdAt;
      const control: TimelineTurnProcess = {
        type: 'turn-process',
        id: turnId,
        blocks: process,
        groups: groups.length,
        ...(startedAt !== undefined && endedAt !== undefined ? { startedAt, endedAt } : {}),
      };
      turnItems.splice(turnItems.indexOf(groups[0]!), 0, control);
    }
    items.push(...turnItems);
  });
  return items;
}

function sameBlocks(known: readonly TimelineBlock[], next: readonly TimelineBlock[]): boolean {
  return known.length === next.length && known.every((block, index) => block === next[index]);
}

function sameItem(known: TimelineViewItem, item: TimelineViewItem): boolean {
  switch (known.type) {
    case 'block':
      return item.type === 'block' && known.block === item.block;
    case 'activity-group':
      return (
        item.type === 'activity-group' &&
        known.turnId === item.turnId &&
        known.live === item.live &&
        sameBlocks(known.blocks, item.blocks)
      );
    case 'turn-process':
      return (
        item.type === 'turn-process' &&
        known.groups === item.groups &&
        known.startedAt === item.startedAt &&
        known.endedAt === item.endedAt &&
        sameBlocks(known.blocks, item.blocks)
      );
  }
}

/**
 * `groupTranscriptBlocks` for a live transcript. An item whose blocks are the
 * same objects as on the previous call keeps its identity, so one streamed
 * token does not make every earlier activity group recompute its summary and
 * diff totals.
 */
export function createTimelineGrouper(): (blocks: readonly TimelineBlock[], running?: boolean | 'unknown') => TimelineViewItem[] {
  let previous = new Map<string, TimelineViewItem>();
  return (blocks, running = false) => {
    const next = new Map<string, TimelineViewItem>();
    const items = groupTranscriptBlocks(blocks, running).map((item) => {
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
