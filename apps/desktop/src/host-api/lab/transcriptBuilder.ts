import { liveLabel } from './catalogFake';
import { labIso, SECOND } from './labClock';
import type { DesktopTimelineBlock, HarnessKind } from './labContracts';

type BlockStatus = DesktopTimelineBlock['status'];
export type ToolRole = 'command' | 'edit' | 'search' | 'read';

/** How each bridge names shell commands and file edits in its tool blocks. */
const TOOL_NAMES: Readonly<Record<HarnessKind, Readonly<Record<ToolRole, string>>>> = {
  pi: { command: 'bash', edit: 'edit', search: 'grep', read: 'read' },
  'prime-agent': { command: 'bash', edit: 'workspace', search: 'workspace', read: 'ipython' },
  codex: { command: 'commandExecution', edit: 'fileChange', search: 'commandExecution', read: 'commandExecution' },
  hermes: { command: 'Run terminal command', edit: 'Edit file', search: 'Search files', read: 'Read file' },
  'claude-code': { command: 'Bash', edit: 'Edit', search: 'Grep', read: 'Read' },
};

const CODEX_TOOL_LABELS: Readonly<Record<string, string>> = { commandExecution: 'Command', fileChange: 'File change' };

export function toolBlock(harness: HarnessKind, tool: ToolRole, id: string): DesktopTimelineBlock {
  const toolName = TOOL_NAMES[harness][tool];
  if (harness === 'hermes') return { id, kind: 'tool', label: toolName, title: toolName, collapsible: true, status: 'streaming' };
  const label = harness === 'codex' ? CODEX_TOOL_LABELS[toolName] ?? toolName : toolName;
  return { id, kind: 'tool', label, toolName, collapsible: true, status: 'streaming' };
}

/** Shell output as each bridge presents it: Codex prefixes the command, the others echo it. */
export function commandText(harness: HarnessKind, command: string, output: string, cwd = '~/lab/piui'): string {
  return harness === 'codex'
    ? `Command: ${command}\nWorking directory: ${cwd}\n${output}`
    : `$ ${command}\n${output}`;
}

export function fileChangeText(harness: HarnessKind, path: string, diff: string): string {
  return harness === 'codex' ? `update: ${path}\n${diff}` : diff;
}

/**
 * Builds seeded native history for one session. Block ids are stable
 * (`<key>-<n>`) and timestamps advance from a fixed seeded start.
 */
export class TranscriptBuilder {
  private readonly blocks: DesktopTimelineBlock[] = [];
  private serial = 0;
  private cursor: number;

  constructor(
    private readonly harness: HarnessKind,
    private readonly key: string,
    start: number,
    private readonly cwd = '~/lab/piui',
  ) {
    this.cursor = start;
  }

  private push(block: Omit<DesktopTimelineBlock, 'id' | 'createdAt'>, gapSeconds: number): this {
    this.cursor += gapSeconds * SECOND;
    this.serial += 1;
    this.blocks.push({ id: `${this.key}-${this.serial}`, createdAt: labIso(this.cursor), ...block });
    return this;
  }

  private label(kind: DesktopTimelineBlock['kind']): string {
    return liveLabel(this.harness, kind);
  }

  user(text: string, gapSeconds = 45): this {
    return this.push({ kind: 'user', label: this.label('user'), text, status: 'complete' }, gapSeconds);
  }

  thinking(text: string, gapSeconds = 4): this {
    return this.push({ kind: 'thinking', label: this.label('thinking'), text, status: 'complete' }, gapSeconds);
  }

  assistant(text: string, status: BlockStatus = 'complete', gapSeconds = 20): this {
    return this.push({ kind: 'assistant', label: this.label('assistant'), text, status }, gapSeconds);
  }

  private tool(tool: ToolRole, text: string, status: BlockStatus, gapSeconds: number): this {
    const { id: _id, ...base } = toolBlock(this.harness, tool, 'pending');
    const summary = status === 'failed' ? 'The tool failed.' : 'The tool completed.';
    return this.push({ ...base, text, status, ...(this.harness === 'pi' ? { safeSummary: summary } : {}) }, gapSeconds);
  }

  command(command: string, output: string, status: BlockStatus = 'complete', gapSeconds = 8): this {
    return this.tool('command', commandText(this.harness, command, output, this.cwd), status, gapSeconds);
  }

  read(path: string, content: string, gapSeconds = 3): this {
    return this.tool('read', `${path}\n\n${content}`, 'complete', gapSeconds);
  }

  search(command: string, output: string, gapSeconds = 5): this {
    return this.tool('search', commandText(this.harness, command, output, this.cwd), 'complete', gapSeconds);
  }

  fileChange(path: string, diff: string, gapSeconds = 12): this {
    return this.tool('edit', fileChangeText(this.harness, path, diff), 'complete', gapSeconds);
  }

  error(message: string, gapSeconds = 2): this {
    return this.push({ kind: 'error', label: this.label('error'), text: message, safeSummary: message, status: 'failed' }, gapSeconds);
  }

  compaction(summary: string, gapSeconds = 30): this {
    return this.push({ kind: 'compaction', label: this.label('compaction'), text: summary, status: 'complete' }, gapSeconds);
  }

  custom(title: string, text: string, gapSeconds = 5): this {
    return this.push({ kind: 'custom', label: title, title, text, collapsible: true, status: 'complete' }, gapSeconds);
  }

  unknown(summary: string, gapSeconds = 5): this {
    const label = this.label('unknown');
    return this.push({ kind: 'unknown', label, safeSummary: summary, fallback: true, status: 'complete' }, gapSeconds);
  }

  /** Time of the last block; callers use it as the session's `updatedAt`. */
  lastInstant(): string {
    return labIso(this.cursor);
  }

  build(): DesktopTimelineBlock[] {
    return this.blocks;
  }
}
