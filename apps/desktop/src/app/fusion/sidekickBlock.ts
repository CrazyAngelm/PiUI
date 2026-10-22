import type { ReportStatusV1, RoundOutcomeV1, SidekickOpV1 } from '../../host-api/fusionClient';

/**
 * Presentation of a Fusion lead's `sidekick` tool call (ADR-043). The tool
 * result text is written by the PiUI host and starts with header lines the
 * parser below reads: `brief b1 · round r1`, then one bracketed header such as
 * `[PiUI sidekick report b1 · r1 · STATUS done · completed · 1m01s · truncated: no]`.
 * Only the leading lines are read, never the body that follows: a sidekick
 * cannot make its own text look like a header. Anything that does not parse
 * returns `undefined` and the block keeps the generic tool rendering. The
 * result is plain data; the card renders it as text, never as markup.
 */

/** Tool names under which the lead's harness reports the host tool. */
const SIDEKICK_TOOL_NAMES: ReadonlySet<string> = new Set([
  'mcp__piui-workspace__sidekick', // Claude Code (session MCP server)
  'sidekick', // Codex dynamic tool (function name)
  'piui.sidekick', // Codex dynamic tool with its namespace
  'piui/sidekick',
  'piui:sidekick',
  'piui__sidekick',
]);

export function isSidekickTool(toolName: string | undefined): boolean {
  return toolName !== undefined && SIDEKICK_TOOL_NAMES.has(toolName.trim().toLowerCase());
}

const ID = '[A-Za-z0-9][A-Za-z0-9_.-]{0,63}';
const IDS_LINE = new RegExp(`^brief (${ID}) · round (${ID})$`);
const REPORT = new RegExp(`^\\[PiUI sidekick report (${ID}) · (${ID}) · STATUS ([a-z-]{1,24}) · ([a-z-]{1,24}) · ([0-9ms]{1,16}) · truncated: ([^\\]\\n]{1,64})\\]$`);
const REPORT_PAGE = new RegExp(`^\\[PiUI sidekick report (${ID}) page (\\d{1,4})/(\\d{1,4}) · untrusted\\]$`);
const PROGRESS = new RegExp(`^\\[PiUI sidekick (${ID}) · (${ID}) · ([^·\\]\\n]{1,120}) · ([0-9ms]{1,16})\\]$`);
const STATUS = /^\[PiUI sidekick status: ([^\]\n]{1,160})\]$/;
const REFUSED = /^\[PiUI sidekick ([a-z]{3,12}|unknown) refused: ([a-z-]{3,40})\](?: (.*))?$/;
const FINISHED = new RegExp(`^\\[PiUI sidekick round (${ID}) finished(?::[^\\]\\n]{0,240})?\\.?\\]$`);

const REPORT_STATUSES: readonly ReportStatusV1[] = ['done', 'partial', 'blocked', 'needs-decision', 'unknown'];
const ROUND_OUTCOMES: readonly RoundOutcomeV1[] = ['completed', 'interrupted', 'failed', 'no-answer', 'uncertain'];
const OPS: readonly SidekickOpV1[] = ['brief', 'wait', 'status', 'message', 'steer', 'stop', 'diff', 'report', 'close', 'reset'];

function oneOf<T extends string>(values: readonly T[], value: string): T | undefined {
  return values.find((candidate) => candidate === value);
}

interface Common {
  /** The tool operation, only when the result text names it. */
  op: SidekickOpV1 | undefined;
  briefId: string | undefined;
  roundId: string | undefined;
  /** The result text after the recognized header lines, shown as plain preformatted text. */
  rest: string;
}

export type SidekickBlockView =
  | (Common & {
      kind: 'report';
      /** `undefined`: a status word this UI does not know. */
      status: ReportStatusV1 | undefined;
      outcome: RoundOutcomeV1 | undefined;
      duration: string;
      /** The host cut the body; the full text is in `op report`. */
      truncated: boolean;
    })
  | (Common & { kind: 'report-page'; page: number; pages: number })
  | (Common & { kind: 'progress'; state: string; elapsed: string })
  | (Common & { kind: 'status'; state: string })
  | (Common & { kind: 'refused'; code: string })
  | (Common & { kind: 'finished' })
  /** Only the `brief b1 · round r1` line is known (for example an accepted brief). */
  | (Common & { kind: 'text' });

export interface SidekickBlockInput {
  toolName?: string | undefined;
  text?: string | undefined;
}

/**
 * Parses a sidekick tool block. `undefined` means: render the generic tool
 * row (not a sidekick tool, still streaming, or text in an unknown shape).
 */
export function parseSidekickBlock(block: SidekickBlockInput): SidekickBlockView | undefined {
  if (!isSidekickTool(block.toolName)) return undefined;
  const text = block.text;
  if (typeof text !== 'string' || text.length === 0 || text.length > 200_000) return undefined;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  let index = 0;
  const skipBlank = (): void => {
    while (index < lines.length && lines[index]?.trim() === '') index += 1;
  };
  skipBlank();
  let briefId: string | undefined;
  let roundId: string | undefined;
  const ids = IDS_LINE.exec(lines[index] ?? '');
  if (ids) {
    briefId = ids[1];
    roundId = ids[2];
    index += 1;
    skipBlank();
  }
  const head = lines[index] ?? '';
  const after = (): string => lines.slice(index + 1).join('\n').replace(/^\n+/, '');

  const report = REPORT.exec(head);
  if (report) {
    return {
      kind: 'report',
      op: undefined,
      briefId: report[1],
      roundId: report[2],
      status: oneOf(REPORT_STATUSES, report[3] ?? ''),
      outcome: oneOf(ROUND_OUTCOMES, report[4] ?? ''),
      duration: report[5] ?? '',
      truncated: !(report[6] ?? '').startsWith('no'),
      rest: after(),
    };
  }
  const page = REPORT_PAGE.exec(head);
  if (page) {
    return { kind: 'report-page', op: 'report', briefId, roundId: page[1], page: Number(page[2]), pages: Number(page[3]), rest: after() };
  }
  const progress = PROGRESS.exec(head);
  if (progress) {
    return { kind: 'progress', op: undefined, briefId: progress[1], roundId: progress[2], state: (progress[3] ?? '').trim(), elapsed: progress[4] ?? '', rest: after() };
  }
  const status = STATUS.exec(head);
  if (status) return { kind: 'status', op: 'status', briefId, roundId, state: (status[1] ?? '').trim(), rest: after() };
  const refused = REFUSED.exec(head);
  if (refused) {
    const detail = refused[3] ? `${refused[3]}\n` : '';
    return { kind: 'refused', op: oneOf(OPS, refused[1] ?? ''), briefId, roundId, code: refused[2] ?? '', rest: `${detail}${after()}`.trimEnd() };
  }
  const finished = FINISHED.exec(head);
  if (finished) return { kind: 'finished', op: undefined, briefId, roundId: finished[1], rest: after() };

  // Only the ids line is known; its remaining lines are shown as they are.
  if (ids) return { kind: 'text', op: undefined, briefId, roundId, rest: lines.slice(index).join('\n').trim() };
  return undefined;
}

export type SidekickChipTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface SidekickChip {
  /** English locale key. */
  label: string;
  tone: SidekickChipTone;
}

/** The status chip of a card. */
export function sidekickChip(view: SidekickBlockView): SidekickChip {
  switch (view.kind) {
    case 'report':
      if (view.outcome === 'failed' || view.outcome === 'uncertain') return { label: 'failed', tone: 'danger' };
      if (view.outcome === 'interrupted' || view.outcome === 'no-answer') return { label: 'interrupted', tone: 'warning' };
      switch (view.status) {
        case 'done':
          return { label: 'done', tone: 'success' };
        case 'partial':
          return { label: 'partial', tone: 'warning' };
        case 'blocked':
          return { label: 'blocked', tone: 'danger' };
        case 'needs-decision':
          return { label: 'needs a decision', tone: 'warning' };
        case 'unknown':
        case undefined:
          return { label: 'status unknown', tone: 'neutral' };
        default:
          return assertNever(view.status);
      }
    case 'report-page':
      return { label: 'report', tone: 'info' };
    case 'progress':
      return { label: 'working', tone: 'accent' };
    case 'status':
      return { label: 'status', tone: 'neutral' };
    case 'refused':
      return { label: 'refused', tone: 'danger' };
    case 'finished':
      return { label: 'finished', tone: 'neutral' };
    case 'text':
      return { label: 'sent', tone: 'accent' };
    default:
      return assertNever(view);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled sidekick block value: ${String(value)}`);
}
