export type InlineNode =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: InlineNode[] }
  | { kind: 'emphasis'; children: InlineNode[] }
  | { kind: 'delete'; children: InlineNode[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; label: InlineNode[]; href: string };

export type MarkdownBlock =
  | { kind: 'paragraph'; inline: InlineNode[] }
  | { kind: 'heading'; depth: 1 | 2 | 3 | 4; inline: InlineNode[] }
  | { kind: 'code'; language?: string; text: string }
  | { kind: 'quote'; inline: InlineNode[] }
  | { kind: 'list'; ordered: boolean; start?: number; items: InlineNode[][] }
  | { kind: 'rule' };

const BLOCK_START = /^(?:```|#{1,4}\s|>\s?|[-+*]\s+|\d+[.)]\s+|(?:-{3,}|\*{3,}|_{3,})\s*$)/u;
const LIST_ITEM = /^([-+*]|\d+[.)])\s+(.*)$/u;

/** A deliberately small, non-HTML Markdown projection for chat prose. */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```\s*([^`]*)$/u);
    if (fence) {
      const content: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/u.test(lines[index] ?? '')) {
        content.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      const language = fence[1]?.trim().split(/\s+/u)[0] || undefined;
      blocks.push({ kind: 'code', language, text: content.join('\n') });
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/u);
    if (heading) {
      blocks.push({ kind: 'heading', depth: heading[1]!.length as 1 | 2 | 3 | 4, inline: parseInline(heading[2] ?? '') });
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
      blocks.push({ kind: 'quote', inline: parseInline(quoted.join('\n')) });
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
        items.push(parseInline(item[2] ?? ''));
        index += 1;
      }
      blocks.push({ kind: 'list', ordered, start, items });
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? '';
      if (next.trim().length === 0 || BLOCK_START.test(next)) break;
      paragraph.push(next);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', inline: parseInline(paragraph.join('\n')) });
  }

  return blocks;
}

export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let plain = '';
  let cursor = 0;
  while (cursor < source.length) {
    const match = inlineTokenAt(source, cursor);
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

function inlineTokenAt(source: string, start: number): InlineMatch | undefined {
  if (source[start] === '[') return linkAt(source, start);
  if (source[start] === '`') return delimitedAt(source, start, '`', (text) => ({ kind: 'code', text }));
  if (source.startsWith('**', start)) return delimitedAt(source, start, '**', (text) => ({ kind: 'strong', children: parseInline(text) }));
  if (source.startsWith('__', start)) return delimitedAt(source, start, '__', (text) => ({ kind: 'strong', children: parseInline(text) }));
  if (source.startsWith('~~', start)) return delimitedAt(source, start, '~~', (text) => ({ kind: 'delete', children: parseInline(text) }));
  if (source[start] === '*') return delimitedAt(source, start, '*', (text) => ({ kind: 'emphasis', children: parseInline(text) }));
  return undefined;
}

function delimitedAt(source: string, start: number, delimiter: string, node: (text: string) => InlineNode): InlineMatch | undefined {
  const contentStart = start + delimiter.length;
  const lineEnd = source.indexOf('\n', contentStart);
  const close = source.indexOf(delimiter, contentStart);
  if (close <= contentStart || (lineEnd >= 0 && close > lineEnd)) return undefined;
  return { end: close + delimiter.length, node: node(source.slice(contentStart, close)) };
}

function linkAt(source: string, start: number): InlineMatch | undefined {
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
  const hrefOffset = source.slice(labelEnd + 2, hrefWindowEnd).indexOf(')');
  if (hrefOffset < 0) return undefined;
  const hrefEnd = labelEnd + 2 + hrefOffset;
  const label = source.slice(start + 1, labelEnd);
  const href = source.slice(labelEnd + 2, hrefEnd).trim();
  if (label.length === 0 || href.length === 0) return undefined;
  return { end: hrefEnd + 1, node: { kind: 'link', label: parseInline(label), href } };
}

function pushText(nodes: InlineNode[], text: string): void {
  if (text.length === 0) return;
  const previous = nodes[nodes.length - 1];
  if (previous?.kind === 'text') previous.text += text;
  else nodes.push({ kind: 'text', text });
}
