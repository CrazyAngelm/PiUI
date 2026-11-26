import { blockStartedAt } from '../../../features/workspace/blockStarts';
import type { Language } from '../../../features/locale/language';
import { parseTimestamp } from '../../../host-api/projectsClient';
import type { SessionSnapshot } from '../../../host-api/workspaceClient';
import type { SessionTaskKind, SessionTaskStatus } from '../../../../../../contracts/workspace-session-tasks-v1';
import { activityLine, pluralIndex, toolKind } from '../transcript/toolKinds';

/**
 * What a chat is running right now (ADR-072): the live agent's own subagents and
 * shell commands. Native tasks come from `SessionSnapshot.tasks`; a harness that
 * reports none still shows the tool calls that are streaming in the timeline.
 */
export interface ActivityItem {
  id: string;
  kind: SessionTaskKind;
  title: string;
  status: SessionTaskStatus;
  background: boolean;
  /** Epoch milliseconds. */
  startedAt?: number;
  /** Epoch milliseconds. */
  endedAt?: number;
  detail?: string;
  activity?: string;
  toolUses?: number;
  totalTokens?: number;
  /** Present when the harness can stop it (`workspace_task_stop_v1`). */
  taskId?: string;
}

export interface SessionActivityView {
  agents: ActivityItem[];
  commands: ActivityItem[];
  other: ActivityItem[];
  /** Items that are running, over all groups. */
  running: number;
  /** Running native tasks and agents: work worth a mark outside the panel, unlike the quick tool calls of a turn. */
  ongoing: number;
}

const LIVE_STATUSES: readonly string[] = ['starting', 'idle', 'running', 'stopping'];
const TURN_STATUSES: readonly string[] = ['starting', 'running', 'stopping'];
const COMPUTER_USE_TOOL = 'mcp__nano-computer-use__computer_use';

export function hasActiveComputerUseRequest(snapshot: SessionSnapshot | undefined): boolean {
  return snapshot?.session.harness === 'claude-code'
    && (snapshot.session.status === 'running' || snapshot.session.status === 'stopping')
    && snapshot.blocks.some((block) =>
      block.kind === 'tool' && block.status === 'streaming' && block.toolName === COMPUTER_USE_TOOL);
}

const KINDS: readonly SessionTaskKind[] = ['agent', 'command', 'task'];
const STATUSES: readonly SessionTaskStatus[] = ['running', 'completed', 'failed', 'stopped'];
/** Finished items kept per group; the list shows what runs, not a history. */
const FINISHED_LIMIT = 6;

function instant(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const milliseconds = parseTimestamp(value);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** One native task, read defensively: an older host sends nothing and a newer one may send more. */
function nativeItem(value: unknown): { item: ActivityItem; blockId: string | undefined } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const task = value as Record<string, unknown>;
  const { id, title, startedAt } = task;
  if (typeof id !== 'string' || id === '' || typeof title !== 'string' || typeof startedAt !== 'string') return undefined;
  const status = STATUSES.find((candidate) => candidate === task.status);
  if (status === undefined) return undefined;
  const kind = KINDS.find((candidate) => candidate === task.kind) ?? 'task';
  const started = instant(startedAt);
  const ended = instant(task.endedAt);
  const detail = text(task.detail);
  const activity = text(task.activity);
  const toolUses = count(task.toolUses);
  const totalTokens = count(task.totalTokens);
  return {
    item: {
      id: `task:${id}`,
      kind,
      title,
      status,
      background: task.background === true,
      ...(started === undefined ? {} : { startedAt: started }),
      ...(ended === undefined ? {} : { endedAt: ended }),
      ...(detail === undefined ? {} : { detail }),
      ...(activity === undefined ? {} : { activity }),
      ...(toolUses === undefined ? {} : { toolUses }),
      ...(totalTokens === undefined ? {} : { totalTokens }),
      ...(status === 'running' ? { taskId: id } : {}),
    },
    blockId: text(task.blockId),
  };
}

/** Bridge titles look like `Bash: pnpm test`; the group heading already names the kind. */
function derivedTitle(block: { toolName?: string | undefined }, line: string): string {
  const prefix = block.toolName === undefined ? '' : `${block.toolName}: `;
  if (prefix !== '' && line.startsWith(prefix) && line.length > prefix.length) return line.slice(prefix.length);
  return line;
}

const startOf = (item: ActivityItem): number => item.startedAt ?? Number.POSITIVE_INFINITY;
const endOf = (item: ActivityItem): number => item.endedAt ?? item.startedAt ?? Number.NEGATIVE_INFINITY;

/** Running first, the oldest start first; then the finished, the latest end first, at most six. */
function ordered(items: ActivityItem[]): ActivityItem[] {
  const running = items.filter((item) => item.status === 'running').sort((left, right) => startOf(left) - startOf(right));
  const finished = items
    .filter((item) => item.status !== 'running')
    .sort((left, right) => endOf(right) - endOf(left))
    .slice(0, FINISHED_LIMIT);
  return [...running, ...finished];
}

/** The running and recently finished work of a chat, grouped by kind. */
export function sessionActivity(snapshot: SessionSnapshot | undefined): SessionActivityView {
  const view: SessionActivityView = { agents: [], commands: [], other: [], running: 0, ongoing: 0 };
  if (snapshot === undefined || !LIVE_STATUSES.includes(snapshot.session.status)) return view;

  const items: ActivityItem[] = [];
  const claimed = new Set<string>();
  const seen = new Set<string>();
  const tasks: unknown = (snapshot as { tasks?: unknown }).tasks;
  for (const value of Array.isArray(tasks) ? tasks : []) {
    const native = nativeItem(value);
    if (native === undefined || seen.has(native.item.id)) continue;
    seen.add(native.item.id);
    if (native.blockId !== undefined) claimed.add(native.blockId);
    items.push(native.item);
  }

  if (TURN_STATUSES.includes(snapshot.session.status)) {
    for (const block of snapshot.blocks) {
      if (block.kind !== 'tool' || block.status !== 'streaming' || claimed.has(block.id)) continue;
      const kind = toolKind(block);
      if (kind !== 'agent' && kind !== 'command') continue;
      const started = blockStartedAt(snapshot.session.id, block.id);
      items.push({
        id: `block:${block.id}`,
        kind,
        title: derivedTitle(block, activityLine(block)),
        status: 'running',
        background: false,
        ...(started === undefined ? {} : { startedAt: started }),
      });
    }
  }

  view.agents = ordered(items.filter((item) => item.kind === 'agent'));
  view.commands = ordered(items.filter((item) => item.kind === 'command'));
  view.other = ordered(items.filter((item) => item.kind === 'task'));
  const running = [...view.agents, ...view.commands, ...view.other].filter((item) => item.status === 'running');
  view.running = running.length;
  view.ongoing = running.filter((item) => item.taskId !== undefined || item.kind === 'agent').length;
  return view;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** Elapsed time as `0:42`, `12:05` or `1:02:03`; a negative or unknown span reads `0:00`. */
export function elapsedLabel(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '0:00';
  const total = Math.floor(milliseconds / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

const TOOL_USES: Record<Language, [string, string, string]> = {
  en: ['{n} tool use', '{n} tool uses', '{n} tool uses'],
  ru: ['{n} вызов', '{n} вызова', '{n} вызовов'],
};

const TOKENS: Record<Language, [string, string, string]> = {
  en: ['{n} token', '{n} tokens', '{n} tokens'],
  ru: ['{n} токен', '{n} токена', '{n} токенов'],
};

/** What an item is for and what it used: its detail, tool uses and tokens on one line. */
export function usageLine(item: ActivityItem, language: Language): string {
  const parts: string[] = [];
  if (item.detail !== undefined && item.detail !== '') parts.push(item.detail);
  if (item.toolUses !== undefined) {
    parts.push(TOOL_USES[language][pluralIndex(item.toolUses, language)].replace('{n}', String(Math.round(item.toolUses))));
  }
  if (item.totalTokens !== undefined) {
    const tokens = Math.round(item.totalTokens);
    // A compact number ("18.4K", "18,4 тыс.") takes the many form.
    const form = tokens < 1000 ? pluralIndex(tokens, language) : 2;
    const shown = new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 }).format(tokens);
    parts.push(TOKENS[language][form].replace('{n}', shown));
  }
  return parts.join(' · ');
}
