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
  /** Still working: the last group of a turn that has not finished. */
  live?: boolean;
}

/** One entry of a turn's process: a run of tool and reasoning blocks, or a reply written between two runs. */
export type TimelineProcessPart = TimelineActivityGroup | TimelineBlockItem;

/**
 * Everything the agent did on a turn before its answer, behind one control:
 * the tool and reasoning groups and the replies written between them
 * ("let me check X"). Only the answer after the last group stays in the chat.
 */
export interface TimelineTurnProcess {
  type: 'turn-process';
  /** `turn:<id of the first tool or reasoning block>`: stable while the turn grows and later turns arrive. */
  id: string;
  /** The process in order: groups and the replies between them (the same objects as in the chat). */
  parts: readonly TimelineProcessPart[];
  /** Every tool and reasoning block of the process, in order (the same objects as in its groups). */
  blocks: readonly TimelineBlock[];
  groups: number;
  /** `createdAt` of the user block that opens the turn and of the turn's last block, when both exist. */
  startedAt?: string;
  endedAt?: string;
  /** Still working: the turn has not finished and its last blocks are work. */
  live?: boolean;
  /** The turn ended badly: the control opens by default so the reader sees where it stopped. */
  attention?: boolean;
}

/** What the catalog view (`groupTimelineBlocks`) and one turn's flat grouping produce: they have no process control. */
export type TimelineCatalogItem = TimelineBlockItem | TimelineActivityGroup;

/** What the chat transcript shows: messages and one process control per stretch of work. */
export type TimelineViewItem = TimelineBlockItem | TimelineTurnProcess;

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

function lastIndexWhere<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) if (predicate(items[index]!)) return index;
  return -1;
}

/**
 * One turn's flat grouping: every adjacent tool and reasoning block between two
 * replies is one activity group; replies, errors and every other block stay
 * their own items, in their native order. An assistant block with no text yet
 * does not cut a group in two.
 */
function groupTurn(turn: readonly TimelineBlock[], working: boolean): TimelineCatalogItem[] {
  const items: TimelineCatalogItem[] = [];
  let run: TimelineBlock[] = [];
  let held: TimelineBlock[] = [];

  const flush = (): TimelineActivityGroup | undefined => {
    if (run.length === 0) return undefined;
    const group = createActivityGroup(run);
    items.push(group);
    for (const block of held) items.push({ type: 'block', block });
    run = [];
    held = [];
    return group;
  };

  for (const block of turn) {
    if (isActivityBlock(block)) {
      run.push(block);
    } else if (isTransparent(block)) {
      if (run.length > 0) held.push(block);
      else items.push({ type: 'block', block });
    } else {
      flush();
      items.push({ type: 'block', block });
    }
  }
  // The group still open when the turn's blocks end is the one at work.
  const trailing = flush();
  if (trailing && working) trailing.live = true;
  return items;
}

/** A reply that may be folded into the process: finished or streaming, and nothing else hangs on it. */
function foldable(item: TimelineCatalogItem, keep: (block: TimelineBlock) => boolean): boolean {
  if (item.type === 'activity-group') return true;
  const block = item.block;
  return block.kind === 'assistant' && (block.status === 'complete' || block.status === 'streaming') && !keep(block);
}

function createProcess(parts: readonly TimelineProcessPart[], span: { startedAt?: string; endedAt?: string }): TimelineTurnProcess {
  const groups = parts.filter((part): part is TimelineActivityGroup => part.type === 'activity-group');
  const blocks = groups.flatMap((group) => group.blocks);
  return {
    type: 'turn-process',
    id: `turn:${blocks[0]!.id}`,
    parts,
    blocks,
    groups: groups.length,
    ...(span.startedAt !== undefined && span.endedAt !== undefined ? { startedAt: span.startedAt, endedAt: span.endedAt } : {}),
    ...(groups[groups.length - 1]!.live === true ? { live: true } : {}),
  };
}

/** The reply a finished turn ends with: the last one with text, even when more work was logged after it. */
function lastReply(turn: readonly TimelineBlock[]): TimelineBlock | undefined {
  for (let index = turn.length - 1; index >= 0; index -= 1) {
    const block = turn[index]!;
    if (block.kind === 'assistant' && block.status === 'complete' && (block.text ?? block.safeSummary ?? '').trim() !== '') return block;
  }
  return undefined;
}

/**
 * Folds one turn's flat items. Everything from the start of a stretch of work
 * up to its last group, replies between the groups included, goes behind one
 * control; what follows the last group is the answer and stays in the chat.
 * A block that cannot be folded (a failed or stopped reply, a reply the owner
 * keeps, an error, any other block) ends the stretch, so a turn can have more
 * than one control. A finished turn never folds its last reply: if a tool call
 * was logged after the answer, the answer stays in the chat above that call.
 */
function foldTurn(
  flat: readonly TimelineCatalogItem[],
  turn: readonly TimelineBlock[],
  working: boolean,
  keepOwner: (block: TimelineBlock) => boolean,
): TimelineViewItem[] {
  const answer = working ? undefined : lastReply(turn);
  const keep = (block: TimelineBlock): boolean => block === answer || keepOwner(block);
  const startedAt = turn[0]!.kind === 'user' ? turn[0]!.createdAt : undefined;
  const endedAt = turn[turn.length - 1]!.createdAt;
  const span = { ...(startedAt !== undefined ? { startedAt } : {}), ...(endedAt !== undefined ? { endedAt } : {}) };
  const result: TimelineViewItem[] = [];
  let pending: TimelineCatalogItem[] = [];

  const flushPending = (): void => {
    const lastGroup = lastIndexWhere(pending, (item) => item.type === 'activity-group');
    if (lastGroup < 0) {
      for (const item of pending) if (item.type === 'block') result.push(item);
    } else {
      result.push(createProcess(pending.slice(0, lastGroup + 1) as TimelineProcessPart[], span));
      for (const item of pending.slice(lastGroup + 1)) if (item.type === 'block') result.push(item);
    }
    pending = [];
  };

  for (const item of flat) {
    if (foldable(item, keep)) {
      pending.push(item);
      continue;
    }
    flushPending();
    if (item.type === 'block') result.push(item);
  }
  flushPending();

  if (isProblemTurn(turn)) {
    const index = lastIndexWhere(result, (item) => item.type === 'turn-process');
    const control = result[index];
    if (control?.type === 'turn-process') result[index] = { ...control, attention: true };
  }
  return result;
}

/**
 * The chat transcript's grouping. On every turn, the tool and reasoning groups
 * and the replies the agent wrote between them become one `turn-process`
 * control; the answer after the last group stays in the chat. While the turn
 * works, the control is live. No block is dropped, reordered or changed.
 * `keep` names replies that must stay in the chat (a reply that carries a file).
 */
export function groupTranscriptBlocks(
  blocks: readonly TimelineBlock[],
  running: boolean | 'unknown' = false,
  keep: (block: TimelineBlock) => boolean = () => false,
): TimelineViewItem[] {
  const turns = splitTurns(blocks);
  return turns.flatMap((turn, index) => {
    // 'unknown': the owner cannot tell whether the agent still works; only a streaming block says so.
    const working = index === turns.length - 1 && (running === true || turn.some((block) => block.status === 'streaming'));
    return foldTurn(groupTurn(turn, working), turn, working, keep);
  });
}

type AnyItem = TimelineViewItem | TimelineActivityGroup;

function sameBlocks(known: readonly TimelineBlock[], next: readonly TimelineBlock[]): boolean {
  return known.length === next.length && known.every((block, index) => block === next[index]);
}

function sameItem(known: AnyItem, item: AnyItem): boolean {
  switch (known.type) {
    case 'block':
      return item.type === 'block' && known.block === item.block;
    case 'activity-group':
      return item.type === 'activity-group' && known.live === item.live && sameBlocks(known.blocks, item.blocks);
    case 'turn-process':
      return (
        item.type === 'turn-process' &&
        known.groups === item.groups &&
        known.live === item.live &&
        known.attention === item.attention &&
        known.startedAt === item.startedAt &&
        known.endedAt === item.endedAt &&
        known.parts.length === item.parts.length &&
        known.parts.every((part, index) => sameItem(part, item.parts[index]!))
      );
  }
}

/** The previous item when nothing changed; else the new one, keeping the parts that did not change. */
function reuse(known: TimelineViewItem | undefined, item: TimelineViewItem): TimelineViewItem {
  if (known === undefined) return item;
  if (item.type === 'turn-process' && known.type === 'turn-process') {
    const parts = item.parts.map((part, index) => {
      const old = known.parts[index];
      return old !== undefined && sameItem(old, part) ? old : part;
    });
    const candidate = parts.every((part, index) => part === item.parts[index]) ? item : { ...item, parts };
    return sameItem(known, candidate) ? known : candidate;
  }
  return sameItem(known, item) ? known : item;
}

/**
 * `groupTranscriptBlocks` for a live transcript. An item whose blocks are the
 * same objects as on the previous call keeps its identity, and so does every
 * unchanged group inside a process, so one streamed token does not make every
 * earlier group recompute its summary and diff totals.
 */
export function createTimelineGrouper(): (
  blocks: readonly TimelineBlock[],
  running?: boolean | 'unknown',
  keep?: (block: TimelineBlock) => boolean,
) => TimelineViewItem[] {
  let previous = new Map<string, TimelineViewItem>();
  return (blocks, running = false, keep = () => false) => {
    const next = new Map<string, TimelineViewItem>();
    const items = groupTranscriptBlocks(blocks, running, keep).map((item) => {
      const key = item.type === 'block' ? `block:${item.block.id}` : item.id;
      const kept = reuse(previous.get(key), item);
      next.set(key, kept);
      return kept;
    });
    previous = next;
    return items;
  };
}
