import type { DesktopTimelineBlock } from '../../../../../contracts/runtime-protocol';

/**
 * The editable first message of "Continue in another harness", built only
 * from what the person can see: the chat's last request, a short excerpt of
 * the last answer and the changed files the review panel listed. Nothing is
 * converted between history formats; the person edits the draft before
 * sending it, and the source chat is not touched.
 */
export interface HandoffSource {
  title: string;
  harnessLabel: string;
  blocks: readonly DesktopTimelineBlock[];
  /** Paths from the review panel, when it was loaded for this chat. */
  changedFiles?: readonly string[];
  /** The source runs in this worktree branch. */
  branch?: string;
}

/** English template lines (locale keys), filled by `buildHandoffDraft`. */
export interface HandoffCopy {
  intro: string;
  lastRequest: string;
  lastAnswer: string;
  changedFiles: string;
  moreFiles: string;
  next: string;
}

export const HANDOFF_COPY: HandoffCopy = {
  intro: 'I am continuing work from a {0} chat, "{1}".',
  lastRequest: 'The last request there was:',
  lastAnswer: 'The last answer began:',
  changedFiles: 'Files changed so far:',
  moreFiles: '…and {0} more',
  next: 'Please continue from here:',
};

const REQUEST_LIMIT = 1200;
const ANSWER_LIMIT = 600;
const FILE_LIMIT = 20;

function excerpt(text: string, limit: number): string {
  const clean = text.replace(/\r\n?/g, '\n').trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
}

function fill(template: string, values: readonly (string | number)[]): string {
  return template.replace(/\{(\d+)\}/g, (token, index: string) => (Number(index) < values.length ? String(values[Number(index)]) : token));
}

function lastText(blocks: readonly DesktopTimelineBlock[], kind: 'user' | 'assistant'): string | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.kind === kind && block.text?.trim()) return block.text;
  }
  return undefined;
}

export function buildHandoffDraft(source: HandoffSource, copy: HandoffCopy = HANDOFF_COPY): string {
  const parts: string[] = [fill(copy.intro, [source.harnessLabel, source.title])];
  const request = lastText(source.blocks, 'user');
  if (request !== undefined) parts.push(`${copy.lastRequest}\n${quote(excerpt(request, REQUEST_LIMIT))}`);
  const answer = lastText(source.blocks, 'assistant');
  if (answer !== undefined) parts.push(`${copy.lastAnswer}\n${quote(excerpt(answer, ANSWER_LIMIT))}`);
  const files = source.changedFiles ?? [];
  if (files.length > 0) {
    const listed = files.slice(0, FILE_LIMIT).map((path) => `- \`${path}\``);
    if (files.length > FILE_LIMIT) listed.push(`- ${fill(copy.moreFiles, [files.length - FILE_LIMIT])}`);
    parts.push(`${copy.changedFiles}\n${listed.join('\n')}`);
  }
  parts.push(copy.next);
  return `${parts.join('\n\n')}\n`;
}
