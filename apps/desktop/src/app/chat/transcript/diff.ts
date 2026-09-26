/**
 * Minimal unified-diff parser for display. It understands git diffs,
 * plain `---/+++` diffs and Codex file-change text ("update: path" headers).
 * Unrecognised lines are kept as context so nothing is hidden.
 */
export type DiffLineKind = 'add' | 'remove' | 'context' | 'hunk' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNumber?: number;
  newNumber?: number;
}

export interface DiffFile {
  path: string;
  change?: string;
  added: number;
  removed: number;
  lines: DiffLine[];
}

const CODEX_HEADER = /^(add|added|delete|deleted|update|updated|modify|modified|change|changed|rename|renamed|move|moved|create|created)[^:\n]*:\s+(.+)$/i;
const GIT_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let oldLine = 0;
  let newLine = 0;

  const start = (path: string, change?: string): DiffFile => {
    current = { path, change, added: 0, removed: 0, lines: [] };
    files.push(current);
    return current;
  };

  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const git = raw.match(GIT_HEADER);
    if (git) {
      start(git[2] ?? git[1] ?? 'file');
      continue;
    }
    const codex = raw.match(CODEX_HEADER);
    if (codex && !raw.startsWith('+') && !raw.startsWith('-')) {
      start(codex[2]?.trim() ?? 'file', codex[1]?.toLowerCase());
      continue;
    }
    if (raw.startsWith('+++ ') || raw.startsWith('--- ')) {
      const file = current ?? start(raw.slice(4).replace(/^[ab]\//, ''));
      if (raw.startsWith('+++ ') && file.path === 'file') file.path = raw.slice(4).replace(/^[ab]\//, '');
      continue;
    }
    if (/^(index |new file mode|deleted file mode|similarity index|rename from|rename to|old mode|new mode)/.test(raw)) {
      (current ?? start('file')).lines.push({ kind: 'meta', text: raw });
      continue;
    }
    const file = current ?? start('file');
    const hunk = raw.match(HUNK);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      file.lines.push({ kind: 'hunk', text: raw });
    } else if (raw.startsWith('+')) {
      file.added += 1;
      file.lines.push({ kind: 'add', text: raw.slice(1), newNumber: newLine++ });
    } else if (raw.startsWith('-')) {
      file.removed += 1;
      file.lines.push({ kind: 'remove', text: raw.slice(1), oldNumber: oldLine++ });
    } else if (raw.startsWith('\\')) {
      file.lines.push({ kind: 'meta', text: raw });
    } else {
      const content = raw.startsWith(' ') ? raw.slice(1) : raw;
      file.lines.push({ kind: 'context', text: content, oldNumber: oldLine++, newNumber: newLine++ });
    }
  }
  // Drop empty trailing context produced by a final newline.
  for (const file of files) {
    while (file.lines.length && file.lines.at(-1)?.kind === 'context' && file.lines.at(-1)?.text === '') file.lines.pop();
  }
  return files.filter((file) => file.lines.length > 0 || file.path !== 'file');
}

export function diffTotals(files: readonly DiffFile[]): { added: number; removed: number } {
  return files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });
}
