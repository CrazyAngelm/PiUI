import {
  MAX_TRIGGER_PATTERN_LENGTH,
  MAX_TRIGGER_PATTERNS,
} from '../../../../contracts/orchestration-host-v7';

/**
 * Project-relative path patterns of "files changed" automations (host v7.2).
 * Mirrors the host's `automation_paths.rs` checks with the same fixtures so
 * the editor explains a refusal before saving. The host stays authoritative.
 */
export type PatternIssue =
  | 'empty'
  | 'too-long'
  | 'control'
  | 'backslash'
  | 'absolute'
  | 'dot-segment'
  | 'empty-segment'
  | 'double-star'
  | 'bracket'
  | 'brace';

export const PATTERN_ISSUE_COPY: Readonly<Record<PatternIssue, string>> = {
  empty: 'Enter a pattern.',
  'too-long': 'Keep each pattern under 256 characters.',
  control: 'Patterns cannot contain control characters.',
  backslash: 'Use / between folders.',
  absolute: 'Use a path inside the project folder, without a drive, / or ~ at the start.',
  'dot-segment': 'Remove ./ and ../ from the pattern.',
  'empty-segment': 'Remove the empty folder name (//).',
  'double-star': 'Use ** as a whole folder name, as in src/**/*.ts.',
  bracket: 'Close each [ ] character class and keep it non-empty.',
  brace: 'Use {a,b} with at least two non-empty choices, without nesting or /.',
};

const MAX_ALTERNATIVES = 64;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/** `expand_braces`: every alternative, or `undefined` for a brace problem. */
function expandBraces(text: string): string[] | undefined {
  const open = text.indexOf('{');
  if (open < 0) return text.includes('}') ? undefined : [text];
  const close = text.indexOf('}', open);
  if (close < 0) return undefined;
  const inner = text.slice(open + 1, close);
  if (inner.includes('{') || inner.includes('/')) return undefined;
  const options = inner.split(',');
  if (options.length < 2 || options.some((option) => option === '')) return undefined;
  const prefix = text.slice(0, open);
  if (prefix.includes('}')) return undefined;
  const rests = expandBraces(text.slice(close + 1));
  if (rests === undefined) return undefined;
  const result: string[] = [];
  for (const rest of rests) {
    for (const option of options) {
      result.push(`${prefix}${option}${rest}`);
      if (result.length > MAX_ALTERNATIVES) return undefined;
    }
  }
  return result;
}

function segmentIssue(part: string): PatternIssue | undefined {
  if (part === '') return 'empty-segment';
  if (part === '.' || part === '..') return 'dot-segment';
  if (part === '**') return undefined;
  if (part.includes('**')) return 'double-star';
  const characters = [...part];
  for (let index = 0; index < characters.length; index += 1) {
    const current = characters[index];
    if (current === ']') return 'bracket';
    if (current !== '[') continue;
    index += 1;
    if (characters[index] === '!' || characters[index] === '^') index += 1;
    let items = 0;
    let closed = false;
    while (index < characters.length) {
      const item = characters[index] ?? '';
      if (item === ']') {
        closed = true;
        break;
      }
      if (item === '[') return 'bracket';
      if (characters[index + 1] === '-') {
        const end = characters[index + 2];
        if (end === undefined || end === ']' || end < item) return 'bracket';
        index += 3;
      } else {
        index += 1;
      }
      items += 1;
    }
    if (!closed || items === 0) return 'bracket';
  }
  return undefined;
}

/** Why the host would refuse this pattern, if it would. */
export function patternIssue(pattern: string): PatternIssue | undefined {
  if (pattern.trim() === '') return 'empty';
  if (new TextEncoder().encode(pattern).length > MAX_TRIGGER_PATTERN_LENGTH) return 'too-long';
  if (CONTROL.test(pattern)) return 'control';
  if (pattern.includes('\\')) return 'backslash';
  if (pattern.startsWith('/') || pattern.startsWith('~') || /^[A-Za-z]:/.test(pattern)) return 'absolute';
  const body = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
  const alternatives = expandBraces(body);
  if (alternatives === undefined) return 'brace';
  for (const alternative of alternatives) {
    for (const part of alternative.split('/')) {
      const issue = segmentIssue(part);
      if (issue !== undefined) return issue;
    }
  }
  return undefined;
}

/**
 * Turns editor text (one pattern per line) into the stored list: trims each
 * line, drops empty lines, uses `/` between folders and drops a leading `./`.
 */
export function patternLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replaceAll('\\', '/').replace(/^(?:\.\/)+/, ''))
    .filter((line) => line !== '');
}

export type PatternListIssue =
  | { readonly kind: 'none-included' }
  | { readonly kind: 'too-many' }
  | { readonly kind: 'pattern'; readonly pattern: string; readonly issue: PatternIssue };

/** The first problem of an include or exclude list, if any. */
export function patternListIssue(patterns: readonly string[], required: boolean): PatternListIssue | undefined {
  if (required && patterns.length === 0) return { kind: 'none-included' };
  if (patterns.length > MAX_TRIGGER_PATTERNS) return { kind: 'too-many' };
  for (const pattern of patterns) {
    const issue = patternIssue(pattern);
    if (issue !== undefined) return { kind: 'pattern', pattern, issue };
  }
  return undefined;
}
