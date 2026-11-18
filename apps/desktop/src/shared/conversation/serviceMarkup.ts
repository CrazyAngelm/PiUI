/**
 * Codex writes a memory citation at the end of some answers:
 * `<oai-mem-citation><citation_entries>...</citation_entries><rollout_ids>...</rollout_ids></oai-mem-citation>`.
 * It is service data for the harness, not prose for the reader, and it is also
 * kept in the native history. It is removed only where the chat shows or copies
 * an answer (the saved history and the harness's own record are never edited),
 * only for a Codex answer, only this exact element (the opening tag, the entries
 * and the optional rollout ids, then the closing tag), and never in code: not in
 * a fenced or indented code block and not in an inline code span. An answer that
 * quotes the tag or talks about it keeps it.
 */
const OPEN = '<oai-mem-citation>';
const CLOSE = '</oai-mem-citation>';
const ENTRIES_OPEN = '<citation_entries>';
const ELEMENT = /<oai-mem-citation>\s*<citation_entries>[\s\S]*?<\/citation_entries>\s*(?:<rollout_ids>[\s\S]*?<\/rollout_ids>\s*)?<\/oai-mem-citation>/gu;
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const INDENTED = /^(?: {4}|\t)/u;

type Range = readonly [start: number, end: number];

/** Where `text` is code: fenced blocks (an unclosed one runs to the end), indented blocks and inline spans. */
function codeRanges(text: string): Range[] {
  const ranges: Range[] = [];
  let offset = 0;
  let fence: { marker: string; start: number } | undefined;
  let previousBlank = true;
  let indentedStart: number | undefined;
  let prose = 0;
  const closeIndented = (end: number): void => {
    if (indentedStart !== undefined) ranges.push([indentedStart, end]);
    indentedStart = undefined;
  };
  const inlineIn = (from: number, to: number): void => {
    for (let at = from; at < to; at += 1) {
      if (text[at] !== '`') continue;
      let run = 1;
      while (at + run < to && text[at + run] === '`') run += 1;
      let close = at + run;
      let found = -1;
      while (close < to) {
        // A code span cannot cross a blank line.
        const next = text.indexOf('`', close);
        if (next < 0 || next >= to) break;
        const gap = text.slice(close, next);
        if (/\n[ \t]*\n/u.test(gap)) break;
        let length = 1;
        while (next + length < to && text[next + length] === '`') length += 1;
        if (length === run) { found = next + length; break; }
        close = next + length;
      }
      if (found >= 0) {
        ranges.push([at, found]);
        at = found - 1;
      } else at += run - 1;
    }
  };
  for (const line of text.split('\n')) {
    const end = offset + line.length;
    const marker = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence.marker[0] && marker.length >= fence.marker.length && line.trim() === marker) {
        ranges.push([fence.start, end]);
        fence = undefined;
        prose = end + 1;
      }
    } else if (marker !== undefined) {
      closeIndented(offset);
      inlineIn(prose, offset);
      fence = { marker, start: offset };
    } else {
      const blank = line.trim() === '';
      if (!blank && INDENTED.test(line) && (previousBlank || indentedStart !== undefined)) {
        indentedStart ??= offset;
      } else if (!blank) {
        closeIndented(offset);
      }
      previousBlank = blank;
    }
    offset = end + 1;
  }
  if (fence !== undefined) ranges.push([fence.start, text.length]);
  else {
    closeIndented(text.length);
    inlineIn(prose, text.length);
  }
  return ranges;
}

const inside = (ranges: readonly Range[], at: number): boolean => ranges.some(([start, end]) => at >= start && at < end);

function citationsRemoved(text: string, streaming: boolean): string {
  const code = codeRanges(text);
  let removed = false;
  let out = '';
  let cursor = 0;
  for (const match of text.matchAll(ELEMENT)) {
    const start = match.index;
    if (inside(code, start)) continue;
    let end = start + match[0].length;
    // An element that fills whole lines takes its line break with it.
    if ((start === 0 || text[start - 1] === '\n') && text[end] === '\n') end += 1;
    out += text.slice(cursor, start);
    cursor = end;
    removed = true;
  }
  out += text.slice(cursor);
  if (streaming) {
    // An element still arriving: its opening tag, then (nothing yet or) the entries.
    const start = out.lastIndexOf(OPEN);
    if (start >= 0 && !inside(codeRanges(out), start) && !spanOpenBefore(out, start)) {
      const rest = out.slice(start + OPEN.length);
      const after = rest.trimStart();
      if (!rest.includes(CLOSE) && (after === '' || after.startsWith(ENTRIES_OPEN) || ENTRIES_OPEN.startsWith(after))) {
        out = out.slice(0, start);
        removed = true;
      }
    }
  }
  return removed ? out.trimEnd() : text;
}

/** A backtick earlier on the line may open an inline code span whose end has not arrived. */
function spanOpenBefore(text: string, at: number): boolean {
  const lineStart = text.lastIndexOf(String.fromCharCode(10), at - 1) + 1;
  return text.slice(lineStart, at).includes('`');
}

/** The opening tag being typed (`<oai-m`) must not flash in a streaming answer. */
function partialTagRemoved(text: string): string {
  const at = text.lastIndexOf('<');
  if (at < 0 || text.length - at >= OPEN.length || !OPEN.startsWith(text.slice(at))) return text;
  if (inside(codeRanges(text), at) || spanOpenBefore(text, at)) return text;
  return text.slice(0, at).trimEnd();
}

/**
 * The text of an assistant answer as the chat shows it. Only a Codex answer
 * (`harness` is `'codex'`) has service markup removed; any other answer is
 * returned as written.
 */
export function stripServiceMarkup(text: string, streaming: boolean = false, harness: string | undefined = undefined): string {
  if (harness !== 'codex' || !text.includes('<')) return text;
  const clean = text.includes(OPEN) ? citationsRemoved(text, streaming) : text;
  return streaming ? partialTagRemoved(clean) : clean;
}
