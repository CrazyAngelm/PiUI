/**
 * Teammate handles and `@handle` mentions (ADR-041). Handles follow
 * `TEAMMATE_HANDLE_PATTERN`; names in any script get an ASCII slug.
 */
import { TEAMMATE_HANDLE_PATTERN, type TeammateV1 } from '../../host-api/teammatesClient';
import type { CommentMentionV1 } from '../../host-api/boardClient';

const CYRILLIC: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u',
};

/** Lowercase ASCII transliteration: Cyrillic by table, Latin diacritics stripped. */
export function transliterate(value: string): string {
  // Map Cyrillic first: NFKD would split "й" into "и" plus a combining breve.
  return [...value.toLowerCase().normalize('NFC')]
    .map((char) => CYRILLIC[char] ?? char)
    .join('')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase();
}

/** A valid handle derived from a display name, e.g. "Ревьюер кода" → "revyuer-koda". */
export function handleFromName(name: string, fallback = 'teammate'): string {
  const slug = transliterate(name)
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32)
    .replace(/-+$/gu, '');
  if (TEAMMATE_HANDLE_PATTERN.test(slug)) return slug;
  if (/^[a-z0-9]$/u.test(slug)) return `${slug}-1`.slice(0, 32);
  return fallback;
}

/** `base`, or `base-2`, `base-3`… when the handle is taken in the project. */
export function uniqueHandle(base: string, taken: readonly string[]): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, 32 - suffix.length).replace(/-+$/u, '')}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return base;
}

export type HandleProblem = 'empty' | 'pattern' | 'taken';

export function handleProblem(handle: string, taken: readonly string[]): HandleProblem | undefined {
  if (!handle) return 'empty';
  if (!TEAMMATE_HANDLE_PATTERN.test(handle)) return 'pattern';
  if (taken.includes(handle)) return 'taken';
  return undefined;
}

/** Up to two initials for an avatar. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const letters = words.length > 1 ? [words[0]?.[0], words[1]?.[0]] : [...(words[0] ?? '')].slice(0, 2);
  return letters.filter((letter): letter is string => Boolean(letter)).join('').toUpperCase() || '?';
}

/** The `@query` being typed at the caret, if any. */
export function activeHandleQuery(text: string, caret: number): { start: number; query: string } | undefined {
  const before = text.slice(0, caret);
  const match = /(^|[\s(])@([a-z0-9-]{0,32})$/u.exec(before);
  if (match === null) return undefined;
  const query = match[2] ?? '';
  return { start: caret - query.length - 1, query };
}

/** Replaces the `@query` at the caret with `@handle ` and returns the new text and caret. */
export function insertHandle(text: string, caret: number, handle: string): { text: string; caret: number } {
  const active = activeHandleQuery(text, caret);
  if (active === undefined) return { text, caret };
  const inserted = `@${handle} `;
  return { text: text.slice(0, active.start) + inserted + text.slice(caret), caret: active.start + inserted.length };
}

export function rankTeammates(teammates: readonly TeammateV1[], query: string): TeammateV1[] {
  const needle = query.toLowerCase();
  return teammates
    .filter((teammate) => teammate.enabled && (teammate.handle.startsWith(needle) || teammate.name.toLowerCase().includes(needle)))
    .sort((left, right) => Number(!left.handle.startsWith(needle)) - Number(!right.handle.startsWith(needle)) || left.handle.localeCompare(right.handle))
    .slice(0, 8);
}

/**
 * Mention spans for every `@handle` of a known teammate in `body` (UTF-16
 * offsets, as the contract stores them). Unknown handles stay plain text.
 */
export function mentionSpans(body: string, teammates: readonly TeammateV1[]): CommentMentionV1[] {
  const byHandle = new Map(teammates.map((teammate) => [teammate.handle, teammate.id]));
  const spans: CommentMentionV1[] = [];
  for (const match of body.matchAll(/(^|[^a-z0-9-])@([a-z0-9][a-z0-9-]{1,31})(?![a-z0-9-])/gu)) {
    const handle = match[2] ?? '';
    const teammateId = byHandle.get(handle);
    if (teammateId === undefined || match.index === undefined) continue;
    const start = match.index + (match[1]?.length ?? 0);
    spans.push({ teammateId, start, length: handle.length + 1 });
  }
  return spans;
}
