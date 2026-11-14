export type InlineNode =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: InlineNode[] }
  | { kind: 'emphasis'; children: InlineNode[] }
  | { kind: 'delete'; children: InlineNode[] }
  | { kind: 'code'; text: string }
  | { kind: 'math'; text: string; display: boolean }
  | { kind: 'link'; label: InlineNode[]; href: string };

export type MarkdownBlock =
  | { kind: 'paragraph'; inline: InlineNode[] }
  | { kind: 'heading'; depth: 1 | 2 | 3 | 4; inline: InlineNode[] }
  | { kind: 'code'; language?: string; text: string }
  | { kind: 'quote'; inline: InlineNode[] }
  | { kind: 'list'; ordered: boolean; start?: number; items: InlineNode[][] }
  | { kind: 'table'; align: TableAlign[]; head: InlineNode[][]; rows: InlineNode[][][] }
  | { kind: 'rule' };

export type TableAlign = 'left' | 'center' | 'right' | undefined;

const BLOCK_START = /^(?:```|#{1,4}\s|>\s?|[-+*]\s+|\d+[.)]\s+|(?:-{3,}|\*{3,}|_{3,})\s*$)/u;
const LIST_ITEM = /^([-+*]|\d+[.)])\s+(.*)$/u;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/u;
/** Tables wider than this are shown as prose rather than a huge grid. */
const MAX_TABLE_COLUMNS = 24;
const BACKSLASH = String.fromCharCode(92);
// Matches the existing web owner's HermesIntelligentUiBlocks grammar.
const WIDGET_FENCE = /^[ \t]{0,3}```hermes-ui[^\n]*$/iu;
const WIDGET_CLOSE = /^[ \t]{0,3}`{3,}[ \t]*$/u;

/** A deliberately small, non-HTML Markdown projection for chat prose. */
export function parseMarkdown(source: string, rich = false): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const widget = rich && WIDGET_FENCE.test(line);
    const fence = widget ? ['', 'hermes-ui'] : line.match(/^```\s*([^`]*)$/u);
    if (fence) {
      const content: string[] = [];
      index += 1;
      while (index < lines.length && !(widget ? WIDGET_CLOSE : /^```\s*$/u).test(lines[index] ?? '')) {
        content.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      const language = fence[1]?.trim().split(/\s+/u)[0] || undefined;
      const text = content.join('\n');
      // The owner's exact-source guard also trims trailing LF. Merely receiving
      // a closing fence must not change an already complete widget's identity.
      blocks.push({ kind: 'code', language, text: widget ? text.replace(/\n+$/u, '') : text });
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/u);
    if (heading) {
      blocks.push({ kind: 'heading', depth: heading[1]!.length as 1 | 2 | 3 | 4, inline: parseInline(heading[2] ?? '', rich) });
      index += 1;
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    if (/^>\s?/u.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^>\s?/u.test(lines[index] ?? '')) {
        quoted.push((lines[index] ?? '').replace(/^>\s?/u, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', inline: parseInline(quoted.join('\n'), rich) });
      continue;
    }

    const table = tableAt(lines, index, rich);
    if (table) {
      blocks.push(table.block);
      index = table.end;
      continue;
    }

    const firstListItem = line.match(LIST_ITEM);
    if (firstListItem) {
      const ordered = /^\d/u.test(firstListItem[1] ?? '');
      const start = ordered ? Number.parseInt(firstListItem[1] ?? '1', 10) : undefined;
      const items: InlineNode[][] = [];
      while (index < lines.length) {
        const item = (lines[index] ?? '').match(LIST_ITEM);
        if (!item || /^\d/u.test(item[1] ?? '') !== ordered) break;
        items.push(parseInline(item[2] ?? '', rich));
        index += 1;
      }
      blocks.push({ kind: 'list', ordered, start, items });
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? '';
      if (next.trim().length === 0 || BLOCK_START.test(next) || (rich && WIDGET_FENCE.test(next)) || isTableStart(lines, index)) break;
      paragraph.push(next);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', inline: parseInline(paragraph.join('\n'), rich) });
  }

  return blocks;
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index] ?? '';
  const delimiter = lines[index + 1] ?? '';
  if (!header.includes('|')) return false;
  if (!TABLE_DELIMITER.test(delimiter)) return false;
  const columns = splitRow(header).length;
  return columns > 0 && columns <= MAX_TABLE_COLUMNS && splitRow(delimiter).length === columns;
}

/** GitHub-style pipe table: header, delimiter row, then rows until a blank line. */
function tableAt(lines: string[], index: number, rich: boolean): { block: MarkdownBlock; end: number } | undefined {
  if (!isTableStart(lines, index)) return undefined;
  const head = splitRow(lines[index] ?? '');
  const align = splitRow(lines[index + 1] ?? '').map((cell): TableAlign => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return undefined;
  });
  const rows: InlineNode[][][] = [];
  let cursor = index + 2;
  while (cursor < lines.length) {
    const line = lines[cursor] ?? '';
    if (line.trim().length === 0 || !line.includes('|')) break;
    const cells = splitRow(line);
    rows.push(head.map((_, column) => parseInline(cells[column] ?? '', rich)));
    cursor += 1;
  }
  return {
    block: { kind: 'table', align, head: head.map((cell) => parseInline(cell, rich)), rows },
    end: cursor,
  };
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith(`${BACKSLASH}|`)) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  let code = false;
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    if (char === BACKSLASH && row[index + 1] === '|') {
      cell += '|';
      index += 1;
    } else if (char === '`') {
      code = !code;
      cell += char;
    } else if (char === '|' && !code) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

export function parseInline(source: string, rich = false): InlineNode[] {
  const nodes: InlineNode[] = [];
  // Repeated unfinished math openers must not rescan the entire remaining stream.
  const mathEnds = rich ? new Map(['\\)', '\\]', '$$', '$'].map(close => [close, source.lastIndexOf(close)])) : undefined;
  let plain = '';
  let cursor = 0;
  while (cursor < source.length) {
    const match = inlineTokenAt(source, cursor, rich, mathEnds);
    if (match === undefined) {
      plain += source[cursor] ?? '';
      cursor += 1;
      continue;
    }
    pushText(nodes, plain);
    plain = '';
    nodes.push(match.node);
    cursor = match.end;
  }
  pushText(nodes, plain);
  return nodes;
}

interface InlineMatch {
  end: number;
  node: InlineNode;
}

function inlineTokenAt(source: string, start: number, rich: boolean, mathEnds: ReadonlyMap<string, number> | undefined): InlineMatch | undefined {
  const math = mathEnds ? mathAt(source, start, mathEnds) : undefined;
  if (math) return math;
  if (source[start] === '[') return linkAt(source, start, rich);
  if (source[start] === '`') return delimitedAt(source, start, '`', (text) => ({ kind: 'code', text }));
  if (source.startsWith('**', start)) return delimitedAt(source, start, '**', (text) => ({ kind: 'strong', children: parseInline(text, rich) }));
  if (source.startsWith('__', start)) return delimitedAt(source, start, '__', (text) => ({ kind: 'strong', children: parseInline(text, rich) }));
  if (source.startsWith('~~', start)) return delimitedAt(source, start, '~~', (text) => ({ kind: 'delete', children: parseInline(text, rich) }));
  if (source[start] === '*') return delimitedAt(source, start, '*', (text) => ({ kind: 'emphasis', children: parseInline(text, rich) }));
  return undefined;
}

/** Rich owner formulas are opaque TeX before Markdown emphasis/link parsing. */
function mathAt(source: string, start: number, ends: ReadonlyMap<string, number>): InlineMatch | undefined {
  if (source[start - 1] === BACKSLASH) return undefined;
  let open: string;
  let close: string;
  let display: boolean;
  if (source.startsWith('\\(', start)) { open = '\\('; close = '\\)'; display = false; }
  else if (source.startsWith('\\[', start)) { open = '\\['; close = '\\]'; display = true; }
  else if (source.startsWith('$$', start)) { open = close = '$$'; display = true; }
  else if (source[start] === '$' && !/\d/u.test(source[start - 1] ?? '')) { open = close = '$'; display = false; }
  else return undefined;
  const begin = start + open.length;
  if ((ends.get(close) ?? -1) <= begin) return undefined;
  let end = source.indexOf(close, begin);
  while (end >= 0 && source[end - 1] === BACKSLASH) end = source.indexOf(close, end + close.length);
  if (end <= begin) return undefined;
  if (open === '$' && (/\d/u.test(source[end + 1] ?? '') || source.slice(begin, end).includes('\n'))) return undefined;
  const text = source.slice(begin, end);
  return { end: end + close.length, node: { kind: 'math', text: display ? `\\[${text}\\]` : `\\(${text}\\)`, display } };
}

function delimitedAt(source: string, start: number, delimiter: string, node: (text: string) => InlineNode): InlineMatch | undefined {
  const contentStart = start + delimiter.length;
  const lineEnd = source.indexOf('\n', contentStart);
  const close = source.indexOf(delimiter, contentStart);
  if (close <= contentStart || (lineEnd >= 0 && close > lineEnd)) return undefined;
  return { end: close + delimiter.length, node: node(source.slice(contentStart, close)) };
}

function linkAt(source: string, start: number, rich: boolean): InlineMatch | undefined {
  if (source[start + 1] === '[') return undefined;
  // Bound malformed-link probing. Streaming output can contain thousands of
  // unmatched `[` characters; each one must remain constant-work rather than
  // rescanning the rest of the growing message.
  const lineEnd = source.indexOf('\n', start + 1);
  const labelWindowEnd = Math.min(lineEnd < 0 ? source.length : lineEnd, start + 257);
  const labelOffset = source.slice(start + 1, labelWindowEnd).indexOf('](');
  if (labelOffset < 0) return undefined;
  const labelEnd = start + 1 + labelOffset;
  const hrefWindowEnd = Math.min(lineEnd < 0 ? source.length : lineEnd, labelEnd + 2_050);
  let depth = 0;
  let hrefEnd = labelEnd + 2;
  for (; hrefEnd < hrefWindowEnd; hrefEnd += 1) {
    const char = source[hrefEnd];
    if (char === BACKSLASH) { hrefEnd += 1; continue; }
    if (char === '(') depth += 1;
    if (char === ')') {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  if (hrefEnd >= hrefWindowEnd) return undefined;
  const label = source.slice(start + 1, labelEnd);
  const href = source.slice(labelEnd + 2, hrefEnd).trim().replace(/\\([\\()])/gu, '$1');
  if (label.length === 0 || href.length === 0) return undefined;
  return { end: hrefEnd + 1, node: { kind: 'link', label: parseInline(label, rich), href } };
}

function pushText(nodes: InlineNode[], text: string): void {
  if (text.length === 0) return;
  const previous = nodes[nodes.length - 1];
  if (previous?.kind === 'text') previous.text += text;
  else nodes.push({ kind: 'text', text });
}
