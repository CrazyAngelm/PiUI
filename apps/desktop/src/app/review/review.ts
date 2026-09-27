import type { ReviewArea, ReviewChange, ReviewFileV1 } from '../../../../../contracts/workspace-review-v1';
import type { DiffLine } from '../chat/transcript/diff';

/** Review groups in display order, with their English labels (locale keys). */
export const AREA_ORDER: readonly ReviewArea[] = ['staged', 'unstaged', 'untracked'];
export const AREA_LABELS: Readonly<Record<ReviewArea, string>> = {
  staged: 'Staged',
  unstaged: 'Changes',
  untracked: 'New files',
};

export const CHANGE_LABELS: Readonly<Record<ReviewChange, string>> = {
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  'type-changed': 'Type changed',
  'intent-to-add': 'Marked to add',
  conflict: 'Conflict',
  submodule: 'Submodule',
};

/** One-letter status marks, like git's short status. */
export const CHANGE_MARKS: Readonly<Record<ReviewChange, string>> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  'type-changed': 'T',
  'intent-to-add': 'A',
  conflict: 'U',
  submodule: 'S',
};

export interface FileGroup {
  area: ReviewArea;
  files: ReviewFileV1[];
}

export function groupFiles(files: readonly ReviewFileV1[]): FileGroup[] {
  return AREA_ORDER.map((area) => ({ area, files: files.filter((file) => file.area === area) })).filter((group) => group.files.length > 0);
}

/** `dir/` and `name` of a repository path. */
export function splitPath(path: string): { directory: string; name: string } {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? { directory: '', name: path } : { directory: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

/** Distinct changed paths, for a handoff draft. */
export function changedPaths(files: readonly ReviewFileV1[]): string[] {
  return [...new Set(files.map((file) => file.path))];
}

export function fileKey(file: { path: string; area: ReviewArea }): string {
  return `${file.area}:${file.path}`;
}

/** A line a comment can point at: `new` numbers for added and context lines, `old` for removed ones. */
export interface LineRef {
  number: number;
  removed: boolean;
  /** A changed line (added or removed), not context. */
  changed: boolean;
  text: string;
}

export function lineRef(line: DiffLine): LineRef | undefined {
  if (line.kind === 'add' || line.kind === 'context') {
    return line.newNumber === undefined ? undefined : { number: line.newNumber, removed: false, changed: line.kind === 'add', text: line.text };
  }
  if (line.kind === 'remove') {
    return line.oldNumber === undefined ? undefined : { number: line.oldNumber, removed: true, changed: true, text: line.text };
  }
  return undefined;
}

/** Lines of the hunk starting at `hunkIndex` (0-based) of a parsed file. */
export function hunkLines(lines: readonly DiffLine[], hunkIndex: number): LineRef[] {
  const refs: LineRef[] = [];
  let current = -1;
  for (const line of lines) {
    if (line.kind === 'hunk') {
      current += 1;
      continue;
    }
    if (current !== hunkIndex) continue;
    const ref = lineRef(line);
    if (ref !== undefined) refs.push(ref);
  }
  return refs;
}

const SNIPPET_LIMIT = 240;

/**
 * The quoted reference a line comment adds to the chat's draft: the path and
 * line, the line itself and the person's note. It is only text in the draft;
 * nothing is sent until the person sends the message.
 */
export function commentReference(path: string, line: LineRef, note: string): string {
  const snippet = line.text.length > SNIPPET_LIMIT ? `${line.text.slice(0, SNIPPET_LIMIT)}…` : line.text;
  const where = line.removed ? `\`${path}\` (removed line ${line.number})` : `\`${path}:${line.number}\``;
  const quote = snippet.trim() ? `> ${snippet.replace(/\s+$/, '')}` : '> (empty line)';
  const body = note.trim();
  return body ? `${where}\n${quote}\n\n${body}` : `${where}\n${quote}`;
}

/** Appends `addition` to a draft with one blank line between them. */
export function appendToDraft(draft: string, addition: string): string {
  const trimmed = draft.replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n\n${addition}` : addition;
}

/** The file header lines plus hunk `index` of a one-file diff text. */
export function hunkText(text: string, index: number): string {
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  const header: string[] = [];
  const hunks: string[][] = [];
  for (const line of lines) {
    if (line.startsWith('@@')) hunks.push([line]);
    else if (hunks.length === 0) header.push(line);
    else hunks.at(-1)?.push(line);
  }
  return `${[...header, ...(hunks[index] ?? [])].join('\n')}\n`;
}

export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One part of a hunk split at its runs of context lines. */
export interface HunkPart {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The part's lines as they appear in the diff (with `\` markers). */
  lines: string[];
}

interface TextHunk {
  head: string;
  lines: string[];
}

function textLines(text: string): string[] {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body === '' ? [] : body.split('\n');
}

/** The file header lines and hunks of a one-file diff text. */
function textHunks(text: string): { header: string[]; hunks: TextHunk[] } {
  const header: string[] = [];
  const hunks: TextHunk[] = [];
  for (const line of textLines(text)) {
    if (line.startsWith('@@')) hunks.push({ head: line, lines: [] });
    else if (hunks.length === 0) header.push(line);
    else hunks.at(-1)?.lines.push(line);
  }
  return { header, hunks };
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The parts hunk `index` of a one-file diff splits into, like the split of
 * `git add -p`: one part per run of changed lines, with the context before
 * and after it (context between two runs belongs to both). A hunk with one
 * run of changes is one part. Mirrors `FilePatch::hunk_parts` on the host,
 * which rebuilds the same parts from the reviewed diff (golden fixture
 * `review.hunkSplit` in `workspace-session-tools-v1.json`).
 */
export function splitHunk(text: string, index: number): HunkPart[] {
  const hunk = textHunks(text).hunks[index];
  const match = hunk === undefined ? null : HUNK_HEADER.exec(hunk.head);
  if (hunk === undefined || match === null) return [];
  const count = (value: string | undefined) => (value === undefined ? 1 : Number(value));
  const whole: HunkPart = {
    oldStart: Number(match[1]),
    oldLines: count(match[2]),
    newStart: Number(match[3]),
    newLines: count(match[4]),
    lines: hunk.lines,
  };
  const rows: { changed: boolean; lines: string[]; old: number; new: number }[] = [];
  for (const line of hunk.lines) {
    if (line.startsWith('\\')) {
      rows.at(-1)?.lines.push(line);
      continue;
    }
    const kind = line[0];
    rows.push({ changed: kind === '-' || kind === '+', lines: [line], old: kind === '+' ? 0 : 1, new: kind === '-' ? 0 : 1 });
  }
  const runs: { start: number; end: number }[] = [];
  rows.forEach((row, position) => {
    if (!row.changed) return;
    const last = runs.at(-1);
    if (last !== undefined && last.end === position) last.end = position + 1;
    else runs.push({ start: position, end: position + 1 });
  });
  if (runs.length < 2) return [whole];
  const sum = (from: number, to: number) =>
    rows.slice(from, to).reduce((total, row) => ({ old: total.old + row.old, new: total.new + row.new }), { old: 0, new: 0 });
  return runs.map((_, number) => {
    const first = number === 0 ? 0 : (runs[number - 1]?.end ?? 0);
    const last = runs[number + 1]?.start ?? rows.length;
    const before = sum(0, first);
    const inside = sum(first, last);
    return {
      oldStart: whole.oldStart + before.old,
      oldLines: inside.old,
      newStart: whole.newStart + before.new,
      newLines: inside.new,
      lines: rows.slice(first, last).flatMap((row) => row.lines),
    };
  });
}

/** `@@ -a,b +c,d @@` the way git writes it (a count of 1 is omitted). */
export function partHeader(part: HunkPart): string {
  const range = (start: number, lines: number) => (lines === 1 ? String(start) : `${start},${lines}`);
  return `@@ -${range(part.oldStart, part.oldLines)} +${range(part.newStart, part.newLines)} @@`;
}

/** The exact patch the host applies for part `part` of hunk `hunk`. */
export function partPatch(text: string, hunk: number, part: number): string | undefined {
  const chosen = splitHunk(text, hunk)[part];
  if (chosen === undefined) return undefined;
  const header = textHunks(text).header.filter((line) => /^(diff --git |--- |\+\+\+ )/.test(line));
  return `${[...header, partHeader(chosen), ...chosen.lines].join('\n')}\n`;
}

/** What a shown hunk stands for: a whole hunk, or one part of a split one. */
export interface HunkTarget {
  hunk: number;
  part?: number;
}

/**
 * The diff text with the hunks in `split` shown as their parts, and what
 * each shown hunk stands for. Hunks with one run of changes stay whole.
 */
export function splitDisplay(text: string, split: ReadonlySet<number>): { text: string; targets: HunkTarget[] } {
  const { header, hunks } = textHunks(text);
  const lines = [...header];
  const targets: HunkTarget[] = [];
  hunks.forEach((hunk, index) => {
    const parts = split.has(index) ? splitHunk(text, index) : [];
    if (parts.length > 1) {
      parts.forEach((part, number) => {
        lines.push(partHeader(part), ...part.lines);
        targets.push({ hunk: index, part: number });
      });
    } else {
      lines.push(hunk.head, ...hunk.lines);
      targets.push({ hunk: index });
    }
  });
  return { text: lines.length ? `${lines.join('\n')}\n` : '', targets };
}
