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
