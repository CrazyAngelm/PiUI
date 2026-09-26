import { sha256Hex } from './sha256';

/**
 * A tiny in-memory git for the UI Lab review panel: per path the HEAD, index
 * and work-tree text. It produces unified diffs with three context lines and
 * applies single hunks exactly like `git apply` would for the host, so the
 * panel's stage, unstage and revert flows behave the same without a
 * repository. Nothing here touches a file.
 */
export interface LabRepoFile {
  head?: string;
  index?: string;
  worktree?: string;
  /** Binary files show as a summary and change only as a whole. */
  binary?: boolean;
}

export interface LabRepository {
  branch?: string;
  /** Full commit id of HEAD. */
  head: string;
  folder: string;
  worktree: boolean;
  files: Map<string, LabRepoFile>;
  /** Paths moved to the trash, newest last. */
  trash: string[];
}

export type LabArea = 'staged' | 'unstaged' | 'untracked';
type LineKind = ' ' | '-' | '+';

export interface LabHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: { kind: LineKind; text: string }[];
}

function splitLines(text: string | undefined): string[] {
  if (text === undefined || text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Longest-common-subsequence edit script; lab files stay small. */
function editScript(before: readonly string[], after: readonly string[]): { kind: LineKind; text: string }[] {
  const rows = before.length;
  const columns = after.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[row]![column] = before[row] === after[column]
        ? table[row + 1]![column + 1]! + 1
        : Math.max(table[row + 1]![column]!, table[row]![column + 1]!);
    }
  }
  const script: { kind: LineKind; text: string }[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (before[row] === after[column]) {
      script.push({ kind: ' ', text: before[row]! });
      row += 1;
      column += 1;
    } else if (table[row + 1]![column]! >= table[row]![column + 1]!) {
      script.push({ kind: '-', text: before[row]! });
      row += 1;
    } else {
      script.push({ kind: '+', text: after[column]! });
      column += 1;
    }
  }
  while (row < rows) script.push({ kind: '-', text: before[row++]! });
  while (column < columns) script.push({ kind: '+', text: after[column++]! });
  return script;
}

/** Groups an edit script into hunks with `context` lines around changes. */
export function hunksOf(before: string | undefined, after: string | undefined, context = 3): LabHunk[] {
  const script = editScript(splitLines(before), splitLines(after));
  const changed = script.map((line, index) => (line.kind === ' ' ? -1 : index)).filter((index) => index >= 0);
  if (changed.length === 0) return [];
  const ranges: [number, number][] = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(script.length - 1, index + context);
    const last = ranges.at(-1);
    if (last !== undefined && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  const hunks: LabHunk[] = [];
  for (const [start, end] of ranges) {
    let oldLine = 1;
    let newLine = 1;
    for (let index = 0; index < start; index += 1) {
      if (script[index]!.kind !== '+') oldLine += 1;
      if (script[index]!.kind !== '-') newLine += 1;
    }
    const lines = script.slice(start, end + 1);
    const oldLines = lines.filter((line) => line.kind !== '+').length;
    const newLines = lines.filter((line) => line.kind !== '-').length;
    hunks.push({
      oldStart: oldLines === 0 ? oldLine - 1 : oldLine,
      oldLines,
      newStart: newLines === 0 ? newLine - 1 : newLine,
      newLines,
      lines,
    });
  }
  return hunks;
}

function range(start: number, lines: number): string {
  return lines === 1 ? String(start) : `${start},${lines}`;
}

/** Unified diff text as the host shows it (no `index` line). */
export function diffText(path: string, before: string | undefined, after: string | undefined, binary = false): string {
  let text = `diff --git a/${path} b/${path}\n`;
  if (before === undefined) text += 'new file mode 100644\n';
  if (after === undefined) text += 'deleted file mode 100644\n';
  if (binary) return text;
  text += `--- ${before === undefined ? '/dev/null' : `a/${path}`}\n+++ ${after === undefined ? '/dev/null' : `b/${path}`}\n`;
  for (const hunk of hunksOf(before, after)) {
    text += `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@\n`;
    for (const line of hunk.lines) text += `${line.kind}${line.text}\n`;
  }
  return text;
}

function joinLines(lines: readonly string[]): string | undefined {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** Applies one hunk (forward: old → new; reverse: new → old) to `text`. */
export function applyHunk(text: string | undefined, hunk: LabHunk, reverse: boolean): string | undefined {
  const lines = splitLines(text);
  const from = hunk.lines.filter((line) => line.kind !== (reverse ? '-' : '+')).map((line) => line.text);
  const to = hunk.lines.filter((line) => line.kind !== (reverse ? '+' : '-')).map((line) => line.text);
  const start = Math.max(0, (reverse ? hunk.newStart : hunk.oldStart) - (from.length === 0 ? 0 : 1));
  const current = lines.slice(start, start + from.length);
  if (current.length !== from.length || current.some((line, index) => line !== from[index])) {
    throw new Error('The hunk does not apply.');
  }
  lines.splice(start, from.length, ...to);
  return joinLines(lines);
}

export function tracked(file: LabRepoFile): boolean {
  return file.head !== undefined || file.index !== undefined;
}

export interface LabChange {
  path: string;
  area: LabArea;
  change: 'modified' | 'added' | 'deleted';
  before?: string;
  after?: string;
  binary: boolean;
}

/** Every change of the repository, per area, in path order. */
export function changes(repository: LabRepository): LabChange[] {
  const result: LabChange[] = [];
  // Byte order, like git's index.
  for (const [path, file] of [...repository.files.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    const binary = file.binary === true;
    if (tracked(file)) {
      if (file.index !== file.head) {
        result.push({
          path, area: 'staged', binary, before: file.head, after: file.index,
          change: file.head === undefined ? 'added' : file.index === undefined ? 'deleted' : 'modified',
        });
      }
      if (file.index !== undefined && file.worktree !== file.index) {
        result.push({
          path, area: 'unstaged', binary, before: file.index, after: file.worktree,
          change: file.worktree === undefined ? 'deleted' : 'modified',
        });
      }
    } else if (file.worktree !== undefined) {
      result.push({ path, area: 'untracked', binary, before: undefined, after: file.worktree, change: 'added' });
    }
  }
  return result;
}

export function changeOf(repository: LabRepository, path: string, area: LabArea): LabChange | undefined {
  return changes(repository).find((change) => change.path === path && change.area === area);
}

export function changeText(change: LabChange): string {
  return diffText(change.path, change.before, change.after, change.binary);
}

/** The fingerprint the host would compute for the shown change. */
export function fingerprintOf(change: LabChange): string {
  return sha256Hex(`${change.area}\0${changeText(change)}\0${change.after ?? ''}`);
}

export function lineCounts(change: LabChange): { added: number; removed: number } {
  const lines = hunksOf(change.before, change.after).flatMap((hunk) => hunk.lines);
  return { added: lines.filter((line) => line.kind === '+').length, removed: lines.filter((line) => line.kind === '-').length };
}

/** Stage (index ← work tree), unstage (index ← HEAD) or revert (work tree ← index / trash). */
export function applyChange(
  repository: LabRepository,
  change: LabChange,
  action: 'stage' | 'unstage' | 'revert',
  hunkIndex: number | undefined,
): void {
  const file = repository.files.get(change.path);
  if (file === undefined) throw new Error('Unknown path.');
  const hunk = hunkIndex === undefined ? undefined : hunksOf(change.before, change.after)[hunkIndex];
  if (hunkIndex !== undefined && hunk === undefined) throw new Error('Unknown hunk.');
  switch (action) {
    case 'stage':
      file.index = hunk === undefined ? file.worktree : applyHunk(file.index, hunk, false);
      break;
    case 'unstage':
      file.index = hunk === undefined ? file.head : applyHunk(file.index, hunk, true);
      break;
    case 'revert':
      if (change.area === 'untracked') {
        repository.trash.push(change.path);
        repository.files.delete(change.path);
      } else {
        file.worktree = hunk === undefined ? file.index : applyHunk(file.worktree, hunk, true);
      }
      break;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
  if (file.head === undefined && file.index === undefined && file.worktree === undefined) repository.files.delete(change.path);
}
