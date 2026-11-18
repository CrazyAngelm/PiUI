import { Lexer, Marked, type Token, type TokenizerExtension } from 'marked';
import { decodeEntities } from './markdownEntities';

/*
 * Chat Markdown (ADR-075). `marked`'s Lexer does the CommonMark + GFM work and
 * only its TOKENS are used: they are copied into the small node types below,
 * which the Svelte renderer walks. marked's HTML output is never used and no
 * node can carry markup: raw HTML (block or inline) becomes plain text.
 */

export type InlineNode =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: InlineNode[] }
  | { kind: 'emphasis'; children: InlineNode[] }
  | { kind: 'delete'; children: InlineNode[] }
  | { kind: 'code'; text: string }
  | { kind: 'math'; text: string; display: boolean }
  | { kind: 'image'; alt: string; href: string }
  | { kind: 'link'; label: InlineNode[]; href: string; title?: string };

export interface ListItemNode {
  /** GFM task item: present only for `- [ ]` and `- [x]`. */
  checked?: boolean;
  children: MarkdownBlock[];
}

export type MarkdownBlock =
  /** `tight`: the text of a tight list item, shown without paragraph spacing. */
  | { kind: 'paragraph'; inline: InlineNode[]; tight?: boolean }
  | { kind: 'heading'; depth: 1 | 2 | 3 | 4 | 5 | 6; inline: InlineNode[] }
  | { kind: 'code'; language?: string; text: string }
  | { kind: 'quote'; children: MarkdownBlock[] }
  | { kind: 'list'; ordered: boolean; start?: number; items: ListItemNode[] }
  | { kind: 'table'; align: TableAlign[]; head: InlineNode[][]; rows: InlineNode[][][] }
  | { kind: 'rule' };

export type TableAlign = 'left' | 'center' | 'right' | undefined;

/** A top-level block with its render key. A completed block keeps its entry object while the message streams. */
export interface MarkdownEntry {
  key: string;
  block: MarkdownBlock;
}

export interface MarkdownParser {
  /**
   * The entries for `source`. A parser instance remembers the completed blocks
   * of the text it saw last: when a later call extends that text, only the
   * unfinished end is parsed again and the earlier entries are returned as the
   * same objects. `streaming` renders the end of the text as unfinished.
   */
  parse(source: string, streaming?: boolean): readonly MarkdownEntry[];
}

/** Tables wider than this are shown as prose rather than a huge grid. */
const MAX_TABLE_COLUMNS = 24;
/**
 * marked's inline lexer rescans the rest of a paragraph for ambiguous delimiters, so a long run of
 * `_a_a_a...` is quadratic (about 1 s at 32 KB). Only text that is both long and mostly delimiters is
 * shown as plain text; prose, code-heavy answers and snake_case text stay far below these limits.
 */
const COMPLETE_COST_LIMIT = 100_000_000;
const STREAMING_COST_LIMIT = 20_000_000;
const CHEAP_INLINE_LENGTH = 2_048;
const MATH_WINDOW = 4_096;
/** An unfinished `**bold*` must not flash italics: a delimiter run at the very end of streaming text waits for its next character. */
function trailingDelimiters(text: string): string {
  let start = text.length;
  while (start > 0 && '*_~'.includes(text[start - 1]!)) start -= 1;
  return text.slice(start);
}

/** `text` without the spaces and tabs at its end (a loop: a regex over a long blank run is quadratic). */
function withoutTrailingBlanks(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) end -= 1;
  return text.slice(0, end);
}
const WIDGET_LANGUAGE = 'hermes-ui';

/** The parts of a marked token the converter reads. */
interface RawToken {
  type: string;
  raw: string;
  text?: string;
  tokens?: RawToken[];
  lang?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | '';
  task?: boolean;
  checked?: boolean;
  items?: RawToken[];
  href?: string;
  title?: string | null;
  align?: (string | null)[];
  header?: RawCell[];
  rows?: RawCell[][];
  codeBlockStyle?: string;
  display?: boolean;
}

interface RawCell {
  text: string;
  tokens?: RawToken[];
}

interface Context {
  rich: boolean;
  widgets: boolean;
}

/**
 * Math is opaque text: `$..$`, `$$..$$`, `\(..\)` and `\[..\]` are cut out before
 * emphasis and links see them, so `$a*b*c$` keeps its asterisks. A single `$`
 * follows the pandoc rules (no space inside the edges, no digit right after the
 * closing mark) so prices and shell variables stay prose.
 */
const mathExtension: TokenizerExtension = {
  name: 'math',
  level: 'inline',
  start(src) {
    return src.search(/\$|\\[(\[]/u);
  },
  tokenizer(src, tokens) {
    let open: string;
    let close: string;
    let display = false;
    if (src.startsWith('\\(')) { open = '\\('; close = '\\)'; }
    else if (src.startsWith('\\[')) { open = '\\['; close = '\\]'; display = true; }
    else if (src.startsWith('$$')) { open = close = '$$'; display = true; }
    else if (src.startsWith('$')) {
      open = close = '$';
      const previous = tokens[tokens.length - 1]?.raw.slice(-1) ?? '';
      if (/\d/u.test(previous) || /\s/u.test(src[1] ?? ' ')) return undefined;
    } else return undefined;
    const span = src.slice(open.length, MATH_WINDOW);
    let end = span.indexOf(close);
    while (end > 0 && span[end - 1] === '\\') end = span.indexOf(close, end + close.length);
    if (end <= 0) return undefined;
    const body = span.slice(0, end);
    if (open === '$' && (/\s$/u.test(body) || body.includes('\n') || /\d/u.test(span[end + 1] ?? ''))) return undefined;
    return { type: 'math', raw: src.slice(0, open.length + end + close.length), text: body, display };
  },
};

const markedOptions = new Marked({ gfm: true, breaks: false, extensions: [mathExtension] }).defaults;

function delimiterCount(source: string): number {
  let count = 0;
  for (let index = 0; index < source.length; index += 1) {
    switch (source.charCodeAt(index)) {
      case 33: case 36: case 42: case 60: case 91: case 92: case 95: case 96: case 126: count += 1;
    }
  }
  return count;
}

function inlineIsCostly(source: string, limit: number): boolean {
  const delimiters = delimiterCount(source);
  return delimiters * 5 > source.length && source.length * delimiters > limit;
}

/** A paragraph this size with this many delimiters would stall the lexer: it is shown as plain text instead. */
class BoundedLexer extends Lexer {
  limit = COMPLETE_COST_LIMIT;

  override inlineTokens(src: string, tokens: Token[] = []): Token[] {
    if (src.length > CHEAP_INLINE_LENGTH && inlineIsCostly(src, this.limit)) {
      tokens.push({ type: 'text', raw: src, text: src });
      return tokens;
    }
    return super.inlineTokens(src, tokens);
  }
}

function lexer(limit: number): BoundedLexer {
  const instance = new BoundedLexer(markedOptions);
  instance.limit = limit;
  return instance;
}

function lex(source: string, limit: number): RawToken[] {
  return lexer(limit).lex(source) as unknown as RawToken[];
}

function pushText(nodes: InlineNode[], text: string): void {
  if (text.length === 0) return;
  const previous = nodes[nodes.length - 1];
  if (previous?.kind === 'text') previous.text += text;
  else nodes.push({ kind: 'text', text });
}

function inlineText(nodes: readonly InlineNode[]): string {
  return nodes.map((node) => {
    switch (node.kind) {
      case 'text': case 'code': case 'math': return node.text;
      case 'image': return node.alt;
      case 'link': return inlineText(node.label);
      case 'strong': case 'emphasis': case 'delete': return inlineText(node.children);
    }
  }).join('');
}

function appendInline(nodes: InlineNode[], token: RawToken, context: Context): void {
  switch (token.type) {
    case 'text':
      if (token.tokens !== undefined) for (const child of token.tokens) appendInline(nodes, child, context);
      else pushText(nodes, decodeEntities(token.text ?? token.raw));
      return;
    case 'escape':
      pushText(nodes, token.text ?? token.raw);
      return;
    case 'strong':
      nodes.push({ kind: 'strong', children: convertInline(token.tokens, context) });
      return;
    case 'em':
      nodes.push({ kind: 'emphasis', children: convertInline(token.tokens, context) });
      return;
    case 'del':
      nodes.push({ kind: 'delete', children: convertInline(token.tokens, context) });
      return;
    case 'codespan':
      nodes.push({ kind: 'code', text: token.text ?? '' });
      return;
    case 'br':
      pushText(nodes, '\n');
      return;
    case 'link': {
      const href = decodeEntities(token.href ?? '');
      const label = convertInline(token.tokens, context);
      if (href === '') {
        for (const node of label) nodes.push(node);
      } else {
        const title = token.title ? decodeEntities(token.title) : undefined;
        nodes.push({ kind: 'link', label: label.length > 0 ? label : [{ kind: 'text', text: href }], href, ...(title ? { title } : {}) });
      }
      return;
    }
    case 'image': {
      const href = decodeEntities(token.href ?? '');
      const alt = inlineText(convertInline(token.tokens, context));
      // Only a trusted rich owner may fill an image slot; everyone else gets the description as a link.
      if (context.rich) nodes.push({ kind: 'image', alt, href });
      else if (href !== '') nodes.push({ kind: 'link', label: [{ kind: 'text', text: alt || href }], href });
      else pushText(nodes, alt);
      return;
    }
    case 'math': {
      const body = token.text ?? '';
      if (context.rich) nodes.push({ kind: 'math', text: token.display === true ? `\\[${body}\\]` : `\\(${body}\\)`, display: token.display === true });
      else pushText(nodes, token.raw);
      return;
    }
    case 'checkbox':
      return;
    // Inline HTML and anything unknown is shown as the text that was written; only a line break tag becomes a line break.
    default: {
      const written = token.type === 'html' ? (token.text ?? token.raw) : token.raw;
      pushText(nodes, token.type === 'html' && /^<br\s*\/?>$/iu.test(written) ? '\n' : written);
    }
  }
}

function convertInline(tokens: readonly RawToken[] | undefined, context: Context): InlineNode[] {
  const nodes: InlineNode[] = [];
  for (const token of tokens ?? []) appendInline(nodes, token, context);
  return nodes;
}

function literalParagraph(raw: string): MarkdownBlock {
  return { kind: 'paragraph', inline: [{ kind: 'text', text: raw.replace(/\n+$/u, '') }] };
}

function alignOf(value: string | null | undefined): TableAlign {
  return value === 'left' || value === 'center' || value === 'right' ? value : undefined;
}

function convertBlock(token: RawToken, context: Context): MarkdownBlock | undefined {
  switch (token.type) {
    case 'space': case 'def': case 'checkbox':
      return undefined;
    case 'paragraph': {
      const inline = convertInline(token.tokens, context);
      return inline.length > 0 ? { kind: 'paragraph', inline } : undefined;
    }
    case 'text': {
      const inline = token.tokens !== undefined ? convertInline(token.tokens, context) : [{ kind: 'text', text: decodeEntities(token.text ?? token.raw) } satisfies InlineNode];
      return inline.length > 0 ? { kind: 'paragraph', inline, tight: true } : undefined;
    }
    case 'heading':
      return { kind: 'heading', depth: Math.min(6, Math.max(1, token.depth ?? 1)) as 1 | 2 | 3 | 4 | 5 | 6, inline: convertInline(token.tokens, context) };
    case 'code': {
      const info = token.codeBlockStyle === 'indented' ? undefined : /^\S+/u.exec(token.lang ?? '')?.[0];
      const widget = context.widgets && info?.toLowerCase() === WIDGET_LANGUAGE;
      // A widget's identity must not change when its closing fence arrives: trailing line feeds are not part of it.
      const text = widget ? (token.text ?? '').replace(/\n+$/u, '') : (token.text ?? '');
      const language = widget ? WIDGET_LANGUAGE : info;
      return { kind: 'code', ...(language ? { language } : {}), text };
    }
    case 'blockquote':
      return { kind: 'quote', children: convertBlocks(token.tokens ?? [], context) };
    case 'list': {
      const ordered = token.ordered === true;
      const items = (token.items ?? []).map((item): ListItemNode => ({
        ...(item.task === true ? { checked: item.checked === true } : {}),
        children: convertBlocks(item.tokens ?? [], context),
      }));
      return { kind: 'list', ordered, ...(ordered && typeof token.start === 'number' ? { start: token.start } : {}), items };
    }
    case 'hr':
      return { kind: 'rule' };
    case 'table': {
      const header = token.header ?? [];
      if (header.length === 0 || header.length > MAX_TABLE_COLUMNS) return literalParagraph(token.raw);
      const cell = (value: RawCell | undefined): InlineNode[] => (value === undefined ? [] : convertInline(value.tokens, context));
      return {
        kind: 'table',
        align: header.map((_, column) => alignOf(token.align?.[column])),
        head: header.map(cell),
        rows: (token.rows ?? []).map((row) => header.map((_, column) => cell(row[column]))),
      };
    }
    // Raw HTML blocks are text: nothing the model writes can become markup.
    default:
      return token.raw.trim() === '' ? undefined : literalParagraph(token.raw);
  }
}

function convertBlocks(tokens: readonly RawToken[], context: Context): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  for (const token of tokens) {
    const block = convertBlock(token, context);
    if (block !== undefined) blocks.push(block);
  }
  return blocks;
}

/**
 * Whether the lexer met a link reference definition, at the top level or nested in a quote or a list
 * (marked collects them all in the `links` table of its result): a definition can resolve links in
 * blocks before it, so nothing may stay remembered once there is one.
 */
function hasDefinitions(tokens: readonly RawToken[]): boolean {
  const links = (tokens as { links?: Record<string, unknown> }).links;
  return (links !== undefined && Object.keys(links).length > 0) || tokens.some((token) => token.type === 'def');
}

function lastContentIndex(tokens: readonly RawToken[]): number {
  for (let index = tokens.length - 1; index >= 0; index -= 1) if (tokens[index]!.type !== 'space') return index;
  return -1;
}

/** A fenced block is closed when its last line is a fence at least as long as the opener. */
function fenceClosed(raw: string): boolean {
  const opener = /^ {0,3}(`{3,}|~{3,})/u.exec(raw);
  if (!opener) return true;
  const marker = opener[1]!;
  const lines = raw.replace(/\n+$/u, '').split('\n');
  if (lines.length < 2) return false;
  const last = lines[lines.length - 1]!.replace(/^ {0,3}/u, '').trimEnd();
  return last.length >= marker.length && [...last].every((char) => char === marker[0]);
}

/** Whether the token at `index` can no longer change: a blank line follows it, or it ends by itself. */
function boundaryAfter(tokens: readonly RawToken[], index: number): boolean {
  const token = tokens[index]!;
  if (token.type === 'space' || tokens[index + 1]?.type === 'space') return true;
  switch (token.type) {
    case 'heading': case 'hr': return true;
    case 'code': return token.codeBlockStyle !== 'indented' && fenceClosed(token.raw);
    default: return false;
  }
}

/** Code that continues to the end of the text: its last characters belong to it. */
function openCode(token: RawToken | undefined): boolean {
  return token?.type === 'code' && (token.codeBlockStyle === 'indented' || !fenceClosed(token.raw));
}

/** The closing fence being typed (`` `` `` under a three-backtick opener) is not code yet. */
function withoutPartialFence(block: MarkdownBlock, raw: string): MarkdownBlock {
  if (block.kind !== 'code') return block;
  const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(raw)?.[1];
  if (marker === undefined) return block;
  const newline = block.text.lastIndexOf('\n');
  const last = block.text.slice(newline + 1).trimEnd();
  if (last.length === 0 || last.length >= marker.length || ![...last.replace(/^ {0,3}/u, '')].every((char) => char === marker[0])) return block;
  return { ...block, text: newline < 0 ? '' : block.text.slice(0, newline) };
}

/** Puts text after the last inline content of a block (the held delimiters of a streaming tail). */
function appendLiteral(block: MarkdownBlock, text: string): boolean {
  switch (block.kind) {
    case 'paragraph': case 'heading':
      pushText(block.inline, text);
      return true;
    case 'quote': {
      const last = block.children[block.children.length - 1];
      return last !== undefined && appendLiteral(last, text);
    }
    case 'list': {
      const children = block.items[block.items.length - 1]?.children;
      const last = children?.[children.length - 1];
      return last !== undefined && appendLiteral(last, text);
    }
    case 'table': {
      const row = block.rows[block.rows.length - 1] ?? block.head;
      const cell = row[row.length - 1];
      if (cell === undefined) return false;
      pushText(cell, text);
      return true;
    }
    case 'code': case 'rule':
      return false;
  }
}

class IncrementalParser implements MarkdownParser {
  private readonly context: Context;
  /** The source text covered by `stable`. */
  private prefix = '';
  private stable: MarkdownEntry[] = [];
  private widgetCount = 0;
  /** Link reference definitions can change earlier blocks: the whole text is then parsed every time. */
  private definitions = false;

  constructor(context: Context) {
    this.context = context;
  }

  parse(source: string, streaming: boolean = false): readonly MarkdownEntry[] {
    const text = source.includes('\r') ? source.replace(/\r\n?/gu, '\n') : source;
    if (!text.startsWith(this.prefix)) this.reset();
    try {
      return this.build(text, text.slice(this.prefix.length), streaming);
    } catch {
      // A lexer failure must never blank the message: show the text as written.
      this.reset();
      return [{ key: 'block:0', block: literalParagraph(text) }];
    }
  }

  private reset(): void {
    this.prefix = '';
    this.stable = [];
    this.widgetCount = 0;
    this.definitions = false;
  }

  private build(text: string, tail: string, streaming: boolean): readonly MarkdownEntry[] {
    const limit = streaming ? STREAMING_COST_LIMIT : COMPLETE_COST_LIMIT;
    let lexed = tail;
    let held = '';
    let tokens: RawToken[] | undefined;
    if (streaming) {
      const run = trailingDelimiters(tail);
      if (run !== '') {
        const before = tail.slice(0, tail.length - run.length);
        const body = withoutTrailingBlanks(before);
        // A run that starts a line may be a list marker, a rule or a new paragraph: only one that follows text on its own line waits.
        if (!body.endsWith('\n')) {
          const candidate = lex(body, limit);
          const last = candidate[lastContentIndex(candidate)];
          // Inside code or HTML the run is content, not a half-typed delimiter.
          if (last?.type !== 'html' && !openCode(last)) {
            tokens = candidate;
            lexed = body;
            held = (body === '' ? '' : before.slice(body.length)) + run;
          }
        }
      }
    }
    tokens ??= lex(tail, limit);

    if (!this.definitions && hasDefinitions(tokens)) {
      this.reset();
      this.definitions = true;
      return this.build(text, text, streaming);
    }

    // Every block except the last may be remembered. A list or quote can still take in a later indented line,
    // so the run of them before the last block stays unfinished too.
    let commit = lastContentIndex(tokens);
    while (commit > 0) {
      let previous = commit - 1;
      while (previous >= 0 && tokens[previous]!.type === 'space') previous -= 1;
      const type = previous >= 0 ? tokens[previous]!.type : '';
      if (type !== 'list' && type !== 'blockquote') break;
      commit = previous;
    }
    // Text that follows can still change a block it touches: a paragraph followed by `#` is two blocks until
    // the next character makes it `#tag`, one paragraph. A block is remembered only behind a stable boundary:
    // a blank line, or its own end (a heading line, a rule, a closed fence).
    for (let index = 0; index < commit; index += 1) {
      if (!boundaryAfter(tokens, index)) {
        commit = index;
        break;
      }
    }
    if (commit > 0 && !this.definitions) {
      let offset = 0;
      for (let index = 0; index < commit && offset >= 0; index += 1) {
        const raw = tokens[index]!.raw;
        offset = lexed.startsWith(raw, offset) ? offset + raw.length : -1;
      }
      if (offset > 0) {
        const done = this.entriesFor(tokens.slice(0, commit), this.stable.length, this.widgetCount);
        for (const entry of done.entries) this.stable.push(entry);
        this.widgetCount = done.widgets;
        this.prefix += lexed.slice(0, offset);
        tokens = tokens.slice(commit);
      }
    }

    const rest = this.entriesFor(tokens, this.stable.length, this.widgetCount);
    const lastToken = tokens[lastContentIndex(tokens)];
    const lastEntry = rest.entries[rest.entries.length - 1];
    if (streaming && lastEntry !== undefined && lastToken?.type === 'code' && lastToken.codeBlockStyle !== 'indented' && !fenceClosed(lastToken.raw)) {
      lastEntry.block = withoutPartialFence(lastEntry.block, lastToken.raw);
    }
    if (held !== '') {
      if (lastEntry === undefined || !appendLiteral(lastEntry.block, held)) {
        rest.entries.push({ key: `block:${this.stable.length + rest.entries.length}`, block: { kind: 'paragraph', inline: [{ kind: 'text', text: held }] } });
      }
    }
    return rest.entries.length === 0 ? this.stable.slice() : this.stable.concat(rest.entries);
  }

  private entriesFor(tokens: readonly RawToken[], start: number, widgetStart: number): { entries: MarkdownEntry[]; widgets: number } {
    const entries: MarkdownEntry[] = [];
    let widgets = widgetStart;
    for (const token of tokens) {
      const block = convertBlock(token, this.context);
      if (block === undefined) continue;
      // Final owner cleanup can remove prose before an unchanged widget. Its DOM
      // (and focused controls) belongs to its widget ordinal, not that prose.
      const key = this.context.widgets && block.kind === 'code' && block.language === WIDGET_LANGUAGE ? `widget:${widgets++}` : `block:${start + entries.length}`;
      entries.push({ key, block });
    }
    return { entries, widgets };
  }
}

/** A parser for one message. `rich`: formulas, images and links are shown for a trusted owner. `widgets`: `hermes-ui` fences are interface widgets. */
export function createMarkdownParser(options: { rich?: boolean; widgets?: boolean } = {}): MarkdownParser {
  const rich = options.rich ?? false;
  return new IncrementalParser({ rich, widgets: options.widgets ?? rich });
}

/** A one-shot projection of `source`; use `createMarkdownParser` for text that grows. */
export function parseMarkdown(source: string, rich = false, widgets = rich, streaming = false): MarkdownBlock[] {
  return createMarkdownParser({ rich, widgets }).parse(source, streaming).map((entry) => entry.block);
}

/** Inline Markdown only (a label, a table cell). */
export function parseInline(source: string, rich = false): InlineNode[] {
  try {
    return convertInline(lexer(COMPLETE_COST_LIMIT).inlineTokens(source) as unknown as RawToken[], { rich, widgets: false });
  } catch {
    return [{ kind: 'text', text: source }];
  }
}
