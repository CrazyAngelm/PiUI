/**
 * Composer mention parsing and ranking (pure, no DOM): `/` commands at the
 * start of a message, `@` project files, `$` skills and the macro list a
 * space opens (ADR-060, ADR-074) at the caret. The inserted text is exactly
 * what the harness reads, except a `//name` macro, which the composer
 * replaces with its text when it sends; nothing is executed here.
 */
export type MentionTrigger = '/' | '@' | '$' | 'space';

export interface ActiveMention {
  readonly trigger: MentionTrigger;
  /** Text typed after the trigger, without it. */
  readonly query: string;
  /** Index of the trigger's first character. */
  readonly start: number;
  /** End of the token (exclusive). */
  readonly end: number;
}

export interface MentionTriggers {
  readonly slash: boolean;
  readonly at: boolean;
  readonly dollar: boolean;
  /** The macro list a space opens; off unless the composer has macros to offer. */
  readonly macros?: boolean;
}

const TOKEN_BREAK = /\s/u;
/** A character of a macro name. */
const MACRO_NAME_CHAR = /[\p{L}\p{N}_-]/u;

/**
 * The space that opens the macro list, for a name typed after it up to the
 * caret: the first character of the message, or the second of two spaces
 * right after text. A third space, a space after a line break and a lone
 * space between words open nothing.
 */
function macroSpace(text: string, position: number): { space: number; end: number } | undefined {
  let name = position;
  while (name > 0 && MACRO_NAME_CHAR.test(text[name - 1] ?? '')) name -= 1;
  const space = name - 1;
  if (space < 0 || text[space] !== ' ') return undefined;
  if (space > 0 && !(text[space - 1] === ' ' && /\S/u.test(text[space - 2] ?? ''))) return undefined;
  let end = position;
  while (end < text.length && MACRO_NAME_CHAR.test(text[end] ?? '')) end += 1;
  if (end < text.length && !TOKEN_BREAK.test(text[end] ?? '')) return undefined;
  return { space, end };
}

/**
 * The mention being typed at `caret`, if any. `/` only counts as the first
 * character of a single-line message (native commands must start a
 * message); `@` and `$` start a token after whitespace or at the start. The
 * macro mention starts at its space (`macroSpace`), which the chosen macro
 * replaces.
 */
export function activeMention(text: string, caret: number, triggers: MentionTriggers): ActiveMention | undefined {
  const position = Math.max(0, Math.min(caret, text.length));
  let start = position;
  while (start > 0 && !TOKEN_BREAK.test(text[start - 1] ?? '')) start -= 1;
  let end = position;
  while (end < text.length && !TOKEN_BREAK.test(text[end] ?? '')) end += 1;
  const spaced = triggers.macros ? macroSpace(text, position) : undefined;
  if (spaced) return { trigger: 'space', query: text.slice(spaced.space + 1, position), start: spaced.space, end: spaced.end };
  if (triggers.slash && /^\/[^\s]*$/u.test(text) && position > 0) {
    return { trigger: '/', query: text.slice(1), start: 0, end: text.length };
  }
  const trigger = text[start];
  if (trigger === '@' && triggers.at) return { trigger, query: text.slice(start + 1, position), start, end };
  if (trigger === '$' && triggers.dollar) return { trigger, query: text.slice(start + 1, position), start, end };
  return undefined;
}

/** Replaces the mention token with `replacement` plus a space; returns the new text and caret. */
export function replaceMention(text: string, mention: ActiveMention, replacement: string): { text: string; caret: number } {
  const after = text.slice(mention.end);
  const spaced = after.startsWith(' ') ? replacement : `${replacement} `;
  const next = `${text.slice(0, mention.start)}${spaced}${after}`;
  return { text: next, caret: mention.start + replacement.length + 1 };
}

/** `@relative/path`, quoted when the path contains whitespace. */
export function fileMention(path: string): string {
  return /\s/u.test(path) ? `@"${path}"` : `@${path}`;
}

function subsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return index === needle.length;
}

/**
 * Ranks project paths for an `@` query: file-name prefix, file-name
 * substring, path substring, then an in-order (fuzzy) match; shorter and
 * shallower paths first within a rank. An empty query keeps the host order.
 */
export function rankFiles(files: readonly string[], query: string, limit = 50): string[] {
  const needle = query.trim().replace(/^@+/u, '').replaceAll('\\', '/').toLowerCase();
  if (!needle) return files.slice(0, limit);
  const ranked: { path: string; score: number }[] = [];
  for (const path of files) {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf('/') + 1);
    const score = name.startsWith(needle) ? 0
      : name.includes(needle) ? 1
        : lower.includes(needle) ? 2
          : subsequence(needle, lower) ? 3
            : -1;
    if (score >= 0) ranked.push({ path, score });
  }
  return ranked
    .sort((left, right) => left.score - right.score
      || left.path.split('/').length - right.path.split('/').length
      || left.path.length - right.path.length
      || left.path.localeCompare(right.path))
    .slice(0, limit)
    .map((entry) => entry.path);
}

/** Entries whose name is, starts with, then contains the query (case-insensitive), then those whose description has it. */
export function rankNamed<T extends { readonly name: string; readonly description?: string }>(
  entries: readonly T[],
  query: string,
  limit = 50,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries.slice(0, limit);
  const scored = entries
    .map((entry, index) => {
      const name = entry.name.toLowerCase();
      const score = name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : entry.description?.toLowerCase().includes(needle) ? 3 : -1;
      return { entry, index, score };
    })
    .filter((candidate) => candidate.score >= 0);
  return scored
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, limit)
    .map((candidate) => candidate.entry);
}

/**
 * The trailing `[image]` lines the bridges add to a user block, one per image
 * the message carried; the remaining text is the message itself.
 */
export function splitImageMarkers(text: string): { text: string; images: number } {
  const lines = text.split('\n');
  let images = 0;
  while (lines.length && lines[lines.length - 1] === '[image]') {
    lines.pop();
    images += 1;
  }
  if (!images) return { text, images: 0 };
  while (lines.length && lines[lines.length - 1]?.trim() === '') lines.pop();
  return { text: lines.join('\n'), images };
}
