import type { TimelineBlock } from '../../../host-api/types';
import type { Language } from '../../../features/locale/language';
import { diffTotals, parseDiff } from './diff';

/**
 * Presentation-only classification of native tool activity. It never changes
 * the block; unknown tools fall back to the generic "tool" category.
 */
export type ToolKind = 'thinking' | 'command' | 'edit' | 'read' | 'search' | 'web' | 'agent' | 'tool';

const COMMAND = new Set(['bash', 'shell', 'command', 'exec', 'commandexecution', 'run', 'terminal', 'powershell']);
const EDIT = new Set(['file-change', 'filechange', 'edit', 'write', 'apply_patch', 'applypatch', 'multiedit', 'patch', 'create']);
const READ = new Set(['read', 'view', 'cat', 'open', 'readfile', 'read_file']);
const SEARCH = new Set(['grep', 'find', 'glob', 'ls', 'search', 'rg', 'list']);
const WEB = new Set(['websearch', 'web_search', 'web-search', 'fetch', 'webfetch', 'browse']);
const AGENT = new Set(['agent', 'task', 'subagent', 'spawn_agent', 'collab-agent']);

export function toolKind(block: TimelineBlock): ToolKind {
  if (block.kind === 'thinking') return 'thinking';
  const name = (block.toolName ?? '').toLowerCase();
  const title = (block.title ?? '').toLowerCase();
  const label = (block.label ?? '').toLowerCase();
  if (name.startsWith('workspace.') || title.startsWith('workspace.') || AGENT.has(name)) return 'agent';
  if (COMMAND.has(name) || label === 'command') return 'command';
  if (EDIT.has(name) || label === 'file change' || label === 'diff') return 'edit';
  if (READ.has(name)) return 'read';
  if (WEB.has(name)) return 'web';
  if (SEARCH.has(name)) return 'search';
  return 'tool';
}

export function toolTitle(block: TimelineBlock): string {
  return block.title ?? block.toolName ?? block.label ?? 'Tool';
}

/** Plural form index: en one/other, ru one/few/many. */
export function pluralIndex(count: number, language: Language): 0 | 1 | 2 {
  if (language === 'ru') {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return 0;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 1;
    return 2;
  }
  return count === 1 ? 0 : 2;
}

const PHRASES: Record<Language, Record<Exclude<ToolKind, 'thinking' | 'web'>, [string, string, string]>> = {
  en: {
    command: ['Ran {n} command', 'Ran {n} commands', 'Ran {n} commands'],
    edit: ['Edited {n} file', 'Edited {n} files', 'Edited {n} files'],
    read: ['Read {n} file', 'Read {n} files', 'Read {n} files'],
    search: ['Searched {n} time', 'Searched {n} times', 'Searched {n} times'],
    agent: ['Delegated {n} task', 'Delegated {n} tasks', 'Delegated {n} tasks'],
    tool: ['Used {n} tool', 'Used {n} tools', 'Used {n} tools'],
  },
  ru: {
    command: ['Выполнил {n} команду', 'Выполнил {n} команды', 'Выполнил {n} команд'],
    edit: ['Изменил {n} файл', 'Изменил {n} файла', 'Изменил {n} файлов'],
    read: ['Прочитал {n} файл', 'Прочитал {n} файла', 'Прочитал {n} файлов'],
    search: ['Искал {n} раз', 'Искал {n} раза', 'Искал {n} раз'],
    agent: ['Поручил {n} задачу', 'Поручил {n} задачи', 'Поручил {n} задач'],
    tool: ['Использовал {n} инструмент', 'Использовал {n} инструмента', 'Использовал {n} инструментов'],
  },
};

const SINGLE: Record<Language, { thinking: string; web: string; working: string }> = {
  en: { thinking: 'Thought', web: 'Searched the web', working: 'Working' },
  ru: { thinking: 'Размышлял', web: 'Искал в интернете', working: 'Работает' },
};

const ORDER: ToolKind[] = ['edit', 'command', 'agent', 'read', 'search', 'web', 'tool', 'thinking'];

const MORE_ACTIONS: Record<Language, [string, string, string]> = {
  en: [', and {n} more action', ', and {n} more actions', ', and {n} more actions'],
  ru: [', и ещё {n} действие', ', и ещё {n} действия', ', и ещё {n} действий'],
};

/** Comma-joined activity categories with localized overflow text. */
export function activitySummary(
  blocks: readonly TimelineBlock[],
  language: Language,
): string {
  const counts = new Map<ToolKind, number>();
  for (const block of blocks) {
    const kind = toolKind(block);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  if (counts.size > 1) counts.delete('thinking');
  const parts: Array<{ text: string; actions: number }> = [];
  for (const kind of ORDER) {
    const count = counts.get(kind);
    if (!count) continue;
    if (kind === 'thinking') parts.push({ text: SINGLE[language].thinking, actions: count });
    else if (kind === 'web') parts.push({ text: SINGLE[language].web, actions: count });
    else parts.push({ text: PHRASES[language][kind][pluralIndex(count, language)].replace('{n}', String(count)), actions: count });
  }
  const shown = parts.slice(0, 3);
  const summary = shown
    .map(({ text }, index) => index === 0 ? text : text.charAt(0).toLocaleLowerCase(language) + text.slice(1))
    .join(', ');
  const remaining = parts.slice(3).reduce((total, part) => total + part.actions, 0);
  if (remaining === 0) return summary || SINGLE[language].working;
  return summary + MORE_ACTIONS[language][pluralIndex(remaining, language)].replace('{n}', String(remaining));
}

export function looksLikeDiff(text: string | undefined): boolean {
  if (!text) return false;
  return /^diff --git /m.test(text) || /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text) || (/^--- /m.test(text) && /^\+\+\+ /m.test(text));
}

/** Totals for actual edit diffs in an activity group; other tool output is ignored. */
export function activityDiffTotals(blocks: readonly TimelineBlock[]): { added: number; removed: number } | undefined {
  const totals = diffTotals(
    blocks
      .filter((block) => toolKind(block) === 'edit' && looksLikeDiff(block.text))
      .flatMap((block) => parseDiff(block.text ?? '')),
  );
  return totals.added === 0 && totals.removed === 0 ? undefined : totals;
}

export interface ActivityState {
  /** A call is still running. Outranks every other state. */
  live: boolean;
  /** Tool calls that ended in an error. Reasoning never counts. */
  failed: number;
  /** A call was stopped or declined before it finished. */
  stopped: boolean;
  /** One line describing the running call. */
  current?: string;
}

/** One line for a tool call: its title, else the command its text starts with, else its name. */
export function activityLine(block: TimelineBlock): string {
  const first = (block.text ?? '').split('\n', 1)[0] ?? '';
  const line = block.title
    ?? (first.startsWith('Command: ') ? first.slice('Command: '.length) : first.startsWith('$ ') ? first.slice(2) : undefined);
  return (line?.trim() || block.label || block.toolName || 'Tool').slice(0, 160);
}

/** State of a group of tool calls, from the calls themselves. */
export function activityState(blocks: readonly TimelineBlock[]): ActivityState {
  let failed = 0;
  let stopped = false;
  let running: TimelineBlock | undefined;
  for (const block of blocks) {
    if (block.kind !== 'tool') continue;
    if (block.status === 'streaming') running = block;
    else if (block.status === 'failed') failed += 1;
    else if (block.status === 'interrupted') stopped = true;
  }
  return { live: running !== undefined, failed, stopped, ...(running ? { current: activityLine(running) } : {}) };
}

/** The kind that names a group: the first of the summary's order that occurs, reasoning only when it is all there is. */
export function leadingKind(blocks: readonly TimelineBlock[]): ToolKind {
  const kinds = new Set(blocks.map(toolKind));
  return ORDER.find((kind) => kinds.has(kind)) ?? 'tool';
}

const PREVIEW_LENGTH = 160;

/**
 * One line of reasoning text for a row's header. Finished text gives its first
 * non-empty line; text still streaming gives the first line of its last
 * paragraph, so the line follows what the model is saying now.
 */
export function reasoningPreview(text: string, live: boolean = false): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim());
  let line: string | undefined;
  if (live) {
    let end = lines.length;
    while (end > 0 && lines[end - 1] === '') end -= 1;
    let start = end;
    while (start > 0 && lines[start - 1] !== '') start -= 1;
    line = lines[start];
  } else {
    line = lines.find((entry) => entry !== '');
  }
  const clean = (line ?? '').replaceAll('**', '').replace(/\s+/g, ' ').trim();
  return clean.length > PREVIEW_LENGTH ? `${clean.slice(0, PREVIEW_LENGTH - 1).trimEnd()}…` : clean;
}

const LIVE_LABELS: Record<Language, Record<ToolKind | 'working', string>> = {
  en: {
    command: 'Running a command',
    edit: 'Editing files',
    read: 'Reading files',
    search: 'Searching',
    web: 'Searching the web',
    agent: 'Delegating',
    tool: 'Using a tool',
    thinking: 'Thinking',
    working: 'Working',
  },
  ru: {
    command: 'Выполняет команду',
    edit: 'Изменяет файлы',
    read: 'Читает файлы',
    search: 'Ищет',
    web: 'Ищет в интернете',
    agent: 'Поручает задачу',
    tool: 'Использует инструмент',
    thinking: 'Думает',
    working: 'Работает',
  },
};

/** What a group that is still working is doing now: the running call, else the reasoning, else just "working". */
export function activityLive(blocks: readonly TimelineBlock[], language: Language): { label: string; detail?: string } {
  const labels = LIVE_LABELS[language];
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    if (block.kind === 'tool' && block.status === 'streaming') return { label: labels[toolKind(block)], detail: activityLine(block) };
  }
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!;
    if (block.kind !== 'thinking' || block.status !== 'streaming') continue;
    const detail = reasoningPreview(block.text ?? block.safeSummary ?? '', true);
    return detail ? { label: labels.thinking, detail } : { label: labels.thinking };
  }
  return { label: labels.working };
}
