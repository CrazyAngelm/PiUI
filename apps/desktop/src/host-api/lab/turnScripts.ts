import { liveLabel } from './catalogFake';
import { BUILDER_MARKER, builderAnswer } from './labBuilder';
import type {
  ApprovalDecision, DesktopTimelineBlock, HarnessKind, PermissionMode, SessionStatus, UsageReceipt, WorkspaceApproval,
} from './labContracts';
import { createRandom, type LabRandom } from './labRandom';
import { commandText, fileChangeText, toolBlock } from './transcriptBuilder';
import {
  COMPACTION_SUMMARY, LIVE_COMMANDS, LIVE_DIFFS, LIVE_REPLY_OPENINGS, LIVE_REPLY_SECTIONS, LIVE_THINKING,
  RENDERER_PARAGRAPHS, vitestReport,
} from './transcriptSamples';

export type PendingApproval = Omit<WorkspaceApproval, 'sessionId' | 'id'>;

export interface ApprovalStep {
  readonly kind: 'approval';
  readonly approval: PendingApproval;
  /** Runs before the remaining steps when the request is approved. */
  readonly approved: readonly TurnStep[];
  /** Replaces the remaining steps when the request is denied or cancelled. */
  readonly declined: readonly TurnStep[];
}

/**
 * A live turn is a script interpreted by the session runtime. Waits are the
 * only timer-driven steps; every other step is applied immediately, in order.
 * `continue` lazily extends an endless script.
 */
export type TurnStep =
  | { readonly kind: 'wait'; readonly ms: number }
  | { readonly kind: 'status'; readonly status: SessionStatus }
  | { readonly kind: 'block'; readonly block: DesktopTimelineBlock }
  | { readonly kind: 'delta'; readonly blockId: string; readonly text: string }
  | ApprovalStep
  | { readonly kind: 'usage'; readonly receipt: UsageReceipt }
  | { readonly kind: 'continue'; readonly next: () => readonly TurnStep[] }
  | { readonly kind: 'end'; readonly outcome: 'succeeded' | 'failed' };

export interface TurnContext {
  readonly harness: HarnessKind;
  readonly sessionId: string;
  readonly turn: number;
  readonly permissionMode: PermissionMode;
  /** Display path of the session's project, shown as the command working directory. */
  readonly cwd: string;
}

type StreamStyle = 'delta' | 'replace';
type Pace = readonly [number, number];

const wait = (ms: number): TurnStep => ({ kind: 'wait', ms });

/** Hermes (ACP) re-sends whole blocks; the other bridges stream text deltas. */
export function streamStyle(harness: HarnessKind): StreamStyle {
  return harness === 'hermes' ? 'replace' : 'delta';
}

/** Splits text at word boundaries into chunks of roughly 10–40 characters. */
export function chunkText(text: string, random: LabRandom): string[] {
  const chunks: string[] = [];
  let index = 0;
  while (index < text.length) {
    let end = Math.min(text.length, index + random.int(10, 34));
    const space = text.indexOf(' ', end);
    if (space !== -1 && space - end < 10) end = space + 1;
    chunks.push(text.slice(index, end));
    index = end;
  }
  return chunks;
}

/** Streams `additions` onto a block that already shows `prefix`, then completes it with the full text. */
function streamOnto(
  block: DesktopTimelineBlock,
  prefix: string,
  additions: readonly string[],
  random: LabRandom,
  style: StreamStyle,
  pace: Pace,
): TurnStep[] {
  const steps: TurnStep[] = [];
  let accumulated = prefix;
  for (const addition of additions) {
    accumulated += addition;
    steps.push(wait(random.int(pace[0], pace[1])));
    steps.push(style === 'delta'
      ? { kind: 'delta', blockId: block.id, text: addition }
      : { kind: 'block', block: { ...block, status: 'streaming', text: accumulated } });
  }
  return steps;
}

/** Streaming block → text chunks → the same block completed with the full text. */
export function streamSteps(
  base: DesktopTimelineBlock,
  text: string,
  random: LabRandom,
  style: StreamStyle,
  pace: Pace,
): TurnStep[] {
  const opened: DesktopTimelineBlock = { ...base, status: 'streaming', text: '' };
  return [
    { kind: 'block', block: opened },
    ...streamOnto(opened, '', chunkText(text, random), random, style, pace),
    { kind: 'block', block: { ...base, status: 'complete', text } },
  ];
}

class BlockIds {
  private serial = 0;
  constructor(private readonly prefix: string) {}
  next(): string {
    this.serial += 1;
    return `${this.prefix}-${this.serial}`;
  }
}

function idsFor(context: TurnContext, kind: string): BlockIds {
  return new BlockIds(`live-${context.sessionId.slice(0, 8)}-${kind}${context.turn}`);
}

function textBlock(context: TurnContext, kind: 'user' | 'assistant' | 'thinking', id: string): DesktopTimelineBlock {
  return { id, kind, label: liveLabel(context.harness, kind), status: 'complete' };
}

export function usageStep(context: TurnContext, random: LabRandom): TurnStep {
  const inputTokens = random.int(1_800, 24_000);
  const outputTokens = random.int(250, 3_200);
  return {
    kind: 'usage',
    receipt: {
      id: `lab-usage-${context.sessionId.slice(0, 8)}-${context.turn}`,
      inputTokens,
      outputTokens,
      cacheReadTokens: random.int(0, inputTokens),
      cacheWriteTokens: random.int(0, 1_200),
      totalTokens: inputTokens + outputTokens,
    },
  };
}

/** Codex offers only deny/cancel for commands under strict permission presets. */
function decisionsFor(context: TurnContext): ApprovalDecision[] {
  if (context.harness !== 'codex') return ['approve-once', 'deny', 'cancel'];
  return context.permissionMode === 'read-only' || context.permissionMode === 'workspace-write'
    ? ['deny', 'cancel']
    : ['approve-once', 'approve-session', 'deny', 'cancel'];
}

export function commandApproval(context: TurnContext, command: string): PendingApproval {
  if (context.harness === 'hermes') {
    return {
      kind: 'command',
      title: 'Run terminal command',
      description: 'Hermes requests permission for this operation.',
      decisions: decisionsFor(context),
    };
  }
  return {
    kind: context.harness === 'pi' ? 'permission' : 'command',
    title: context.harness === 'codex' ? 'Run command' : 'Allow this command?',
    description: `Command: ${command}\nWorking directory: ${context.cwd}\nReason: The agent wants to verify its change before answering.`,
    decisions: decisionsFor(context),
  };
}

/**
 * Approval pauses are only generated where the native adapter maps approvals:
 * always for risky-sounding prompts, otherwise now and then after the first turn.
 */
function wantsApproval(context: TurnContext, prompt: string, random: LabRandom): boolean {
  if (context.harness === 'prime-agent') return false;
  if (/\b(deploy|approv\w*|install|delete|remove|e2e|migrat\w*|publish)\b/i.test(prompt)) return true;
  return context.turn > 1 && random.chance(0.3);
}

function commandHeader(context: TurnContext, command: string): string {
  return context.harness === 'codex' ? commandText('codex', command, '', context.cwd) : `$ ${command}\n`;
}

/** A command tool block opened with its header; output lines stream in afterwards. */
function openCommand(context: TurnContext, id: string, command: string): DesktopTimelineBlock {
  return { ...toolBlock(context.harness, 'command', id), text: commandHeader(context, command) };
}

/** Streams a command's output onto an opened tool block and completes it. */
export function commandOutputSteps(
  context: TurnContext,
  opened: DesktopTimelineBlock,
  command: string,
  output: string,
  random: LabRandom,
): TurnStep[] {
  const lines = output.split('\n').map((line, index) => (index === 0 ? line : `\n${line}`));
  const summary = context.harness === 'pi' ? { safeSummary: 'The tool completed.' } : {};
  const text = commandText(context.harness, command, output, context.cwd);
  const complete: DesktopTimelineBlock = { ...opened, ...summary, status: 'complete', text };
  return [
    ...streamOnto(opened, commandHeader(context, command), lines, random, streamStyle(context.harness), [90, 260]),
    { kind: 'block', block: complete },
  ];
}

function editSteps(context: TurnContext, ids: BlockIds, random: LabRandom): TurnStep[] {
  const edit = random.chance(0.6) ? random.pick(LIVE_DIFFS) : undefined;
  if (edit === undefined) return [];
  const block = toolBlock(context.harness, 'edit', ids.next());
  const text = fileChangeText(context.harness, edit.path, edit.diff);
  return [
    wait(random.int(200, 400)),
    { kind: 'block', block },
    wait(random.int(300, 600)),
    { kind: 'block', block: { ...block, status: 'complete', text } },
  ];
}

function reply(prompt: string, random: LabRandom): string {
  const topic = prompt.length > 90 ? `${prompt.slice(0, 87)}…` : prompt;
  const first = random.int(0, LIVE_REPLY_SECTIONS.length - 1);
  const second = (first + random.int(1, LIVE_REPLY_SECTIONS.length - 1)) % LIVE_REPLY_SECTIONS.length;
  return [
    random.pick(LIVE_REPLY_OPENINGS),
    '',
    `> ${topic.replace(/\n/g, ' ')}`,
    '',
    LIVE_REPLY_SECTIONS[first] ?? '',
    '',
    LIVE_REPLY_SECTIONS[second] ?? '',
  ].join('\n');
}

/** The pipeline assistant: think briefly, then stream a proposal. Never asks for approval. */
function builderTurn(context: TurnContext, prompt: string): TurnStep[] {
  const random = createRandom(`${context.sessionId}:builder:${context.turn}`);
  const ids = idsFor(context, 'b');
  const style = streamStyle(context.harness);
  return [
    { kind: 'status', status: 'running' },
    { kind: 'block', block: { ...textBlock(context, 'user', ids.next()), text: prompt } },
    wait(random.int(250, 450)),
    ...streamSteps(textBlock(context, 'thinking', ids.next()), 'Reading the draft and the request, then choosing the smallest graph that can verify the result.', random, style, [25, 60]),
    ...streamSteps(textBlock(context, 'assistant', ids.next()), builderAnswer(prompt), random, style, [60, 140]),
    usageStep(context, random),
    { kind: 'end', outcome: 'succeeded' },
  ];
}

/** A complete chat turn of roughly 2–6 seconds, sometimes pausing for approval. */
export function chatTurn(context: TurnContext, prompt: string): TurnStep[] {
  if (prompt.trimStart().startsWith(BUILDER_MARKER)) return builderTurn(context, prompt);
  const random = createRandom(`${context.sessionId}:turn:${context.turn}`);
  const ids = idsFor(context, 't');
  const style = streamStyle(context.harness);
  const { command, output } = random.pick(LIVE_COMMANDS);
  const opened = openCommand(context, ids.next(), command);
  const assistant = textBlock(context, 'assistant', ids.next());
  const steps: TurnStep[] = [
    { kind: 'status', status: 'running' },
    { kind: 'block', block: { ...textBlock(context, 'user', ids.next()), text: prompt } },
    wait(random.int(250, 450)),
    ...streamSteps(textBlock(context, 'thinking', ids.next()), random.pick(LIVE_THINKING), random, style, [25, 70]),
    wait(random.int(150, 300)),
    { kind: 'block', block: opened },
  ];
  const run = commandOutputSteps(context, opened, command, output, random);
  const rest: TurnStep[] = [
    ...editSteps(context, ids, random),
    wait(random.int(150, 300)),
    ...streamSteps(assistant, reply(prompt, random), random, style, [30, 80]),
    usageStep(context, random),
    { kind: 'end', outcome: 'succeeded' },
  ];
  if (!wantsApproval(context, prompt, random)) return [...steps, ...run, ...rest];
  const declinedText = `I did not run \`${command}\` because the request was declined. `
    + 'Nothing else changed; approve it next time if you want the check to run.';
  const approval: ApprovalStep = {
    kind: 'approval',
    approval: commandApproval(context, command),
    approved: run,
    declined: [
      { kind: 'block', block: { ...opened, status: 'interrupted', safeSummary: 'The command was declined.' } },
      wait(200),
      ...streamSteps(assistant, declinedText, random, style, [20, 55]),
      usageStep(context, random),
      { kind: 'end', outcome: 'succeeded' },
    ],
  };
  return [...steps, approval, ...rest];
}

/** An orchestration task turn: the task prompt, some tool work and the final result text. */
export function taskTurn(context: TurnContext, prompt: string, resultText: string): TurnStep[] {
  const random = createRandom(`${context.sessionId}:task:${context.turn}`);
  const ids = idsFor(context, 'k');
  const style = streamStyle(context.harness);
  const { command, output } = random.pick(LIVE_COMMANDS);
  const opened = openCommand(context, ids.next(), command);
  return [
    { kind: 'status', status: 'running' },
    { kind: 'block', block: { ...textBlock(context, 'user', ids.next()), text: prompt } },
    wait(random.int(300, 500)),
    ...streamSteps(textBlock(context, 'thinking', ids.next()), random.pick(LIVE_THINKING), random, style, [25, 60]),
    wait(200),
    { kind: 'block', block: opened },
    ...commandOutputSteps(context, opened, command, output, random),
    wait(random.int(200, 350)),
    ...streamSteps(textBlock(context, 'assistant', ids.next()), resultText, random, style, [15, 40]),
    usageStep(context, random),
    { kind: 'end', outcome: 'succeeded' },
  ];
}

/** A single model call (`llm` step): the prompt and one short answer, with no tool work. */
export function oneShotTurn(context: TurnContext, prompt: string, resultText: string): TurnStep[] {
  const random = createRandom(`${context.sessionId}:call:${context.turn}`);
  const ids = idsFor(context, 'c');
  return [
    { kind: 'status', status: 'running' },
    { kind: 'block', block: { ...textBlock(context, 'user', ids.next()), text: prompt } },
    wait(random.int(200, 400)),
    ...streamSteps(textBlock(context, 'assistant', ids.next()), resultText, random, streamStyle(context.harness), [10, 30]),
    usageStep(context, random),
    { kind: 'end', outcome: 'succeeded' },
  ];
}

/**
 * The remainder of a task turn that was already under way when the lab
 * started: a slow test run and two more commands (about a minute of visible
 * work), then the result streamed slowly enough to watch.
 */
export function taskContinuation(context: TurnContext, resultText: string): TurnStep[] {
  const random = createRandom(`${context.sessionId}:continuation:${context.turn}`);
  const ids = idsFor(context, 'r');
  const commands = [
    { command: 'pnpm --filter @piui/desktop test', output: vitestReport(12, context.sessionId) },
    ...LIVE_COMMANDS.slice(0, 2),
  ];
  const work = commands.flatMap(({ command, output }): TurnStep[] => {
    const opened = openCommand(context, ids.next(), command);
    const slow = commandOutputSteps(context, opened, command, output, random)
      .map((step) => (step.kind === 'wait' ? wait(step.ms * 8) : step));
    return [wait(random.int(1_500, 3_000)), { kind: 'block', block: opened }, ...slow];
  });
  return [
    ...work,
    wait(1_500),
    ...streamSteps(textBlock(context, 'assistant', ids.next()), resultText, random, streamStyle(context.harness), [60, 140]),
    usageStep(context, random),
    { kind: 'end', outcome: 'succeeded' },
  ];
}

/** Endless "agent is still working" stream: paragraphs interleaved with tool calls. */
export function ambientSegment(context: TurnContext, cycle: number): TurnStep[] {
  const random = createRandom(`${context.sessionId}:ambient:${cycle}`);
  const prefix = `live-${context.sessionId.slice(0, 8)}-a${cycle}`;
  const paragraph = RENDERER_PARAGRAPHS[cycle % RENDERER_PARAGRAPHS.length] ?? '';
  const assistant = textBlock(context, 'assistant', `${prefix}-text`);
  const tool = toolBlock(context.harness, 'read', `${prefix}-tool`);
  const toolText = `notes/incremental-rendering.md (section ${cycle + 1})\n\n${paragraph.split('\n')[0] ?? ''}`;
  return [
    ...streamSteps(assistant, paragraph, random, streamStyle(context.harness), [70, 160]),
    wait(random.int(500, 900)),
    { kind: 'block', block: tool },
    wait(random.int(700, 1_300)),
    { kind: 'block', block: { ...tool, status: 'complete', text: toolText } },
    wait(random.int(400, 800)),
    { kind: 'continue', next: () => ambientSegment(context, cycle + 1) },
  ];
}

/** Native context compaction requested through the composer. */
export function compactionTurn(context: TurnContext): TurnStep[] {
  const block: DesktopTimelineBlock = {
    id: `live-${context.sessionId.slice(0, 8)}-c${context.turn}`,
    kind: 'compaction',
    label: liveLabel(context.harness, 'compaction'),
    safeSummary: 'Context is being compacted.',
    status: 'streaming',
  };
  return [
    { kind: 'status', status: 'running' },
    { kind: 'block', block },
    wait(1_400),
    { kind: 'block', block: { ...block, status: 'complete', text: COMPACTION_SUMMARY } },
    { kind: 'end', outcome: 'succeeded' },
  ];
}
