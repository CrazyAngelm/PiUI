/**
 * Composer macros (ADR-060): the pure rules. A macro is a saved prompt and/or
 * a list of skills, added to a message by typing `//name`. Nothing here reads
 * the DOM or storage, and nothing is executed: sending replaces each `//name`
 * with text the harness reads like any other message (`expand.ts`).
 */
export interface Macro {
  readonly id: string;
  /** Typed after `//`. Lower case, unique among the macros. */
  readonly name: string;
  readonly description: string;
  /** Text added to the message. */
  readonly prompt: string;
  /** Skill names, written in the chat agent's own syntax when sent. */
  readonly skills: readonly string[];
  /** One lower-case letter that picks this macro in the list a space opens; unique among the macros. */
  readonly key?: string;
}

/** What the editor holds; `id` is absent for a new macro. */
export interface MacroDraft {
  readonly id?: string;
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly skills: readonly string[];
  /** Typed in Settings: empty for none, else one letter. */
  readonly key?: string;
}

export type MacroField = 'name' | 'description' | 'skills' | 'content' | 'key';
/** English source copy of the first problem of each field. */
export type MacroErrors = Partial<Record<MacroField, string>>;

export const MACRO_LIMITS = { macros: 200, name: 32, description: 200, prompt: 20_000, skills: 16, skill: 128, id: 64 } as const;

const NAME = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u;
const SKILL = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/**
 * `//name` starts a message or follows whitespace. It ends at whitespace, at
 * the end, or before closing punctuation that itself ends the word, so
 * `//review.` is a macro and `//review.md`, `https://host` and `//a/b` are not.
 */
const TOKEN = /(^|\s)\/\/([\p{L}\p{N}][\p{L}\p{N}_-]*)(?=$|\s|[.,;:!?)\]]+(?:\s|$))/gu;

/** The name as it is stored: without the `//` a person may have typed, lower case. */
export function normalizeMacroName(value: string): string {
  return value.trim().replace(/^\/+/u, '').toLowerCase();
}

const KEY = /^\p{L}$/u;
/** The key as it is stored: lower case, empty for none. */
export function normalizeMacroKey(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/** Skill names from free text: separated by spaces or commas, without a leading `$` or `/`, each once. */
export function parseSkillNames(value: string): string[] {
  const names: string[] = [];
  for (const part of value.split(/[\s,]+/u)) {
    const name = part.replace(/^[$/]+/u, '');
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** The first problem of each field; empty when the draft can be saved among `existing`. */
export function macroErrors(draft: MacroDraft, existing: readonly Macro[]): MacroErrors {
  const errors: MacroErrors = {};
  const name = normalizeMacroName(draft.name);
  const known = existing.some((macro) => macro.id === draft.id);
  if (!name) errors.name = 'Enter a name.';
  else if (name.length > MACRO_LIMITS.name) errors.name = 'The name is too long.';
  else if (!NAME.test(name)) errors.name = 'Use letters, digits, hyphens and underscores.';
  else if (existing.some((macro) => macro.name === name && macro.id !== draft.id)) errors.name = 'Another macro already has this name.';
  else if (!known && existing.length >= MACRO_LIMITS.macros) errors.name = 'Too many macros. Delete one first.';
  const key = normalizeMacroKey(draft.key);
  if (key && !KEY.test(key)) errors.key = 'Use one letter.';
  else if (key && existing.some((macro) => macro.key === key && macro.id !== draft.id)) errors.key = 'Another macro already uses this key.';
  if (draft.description.trim().length > MACRO_LIMITS.description) errors.description = 'The description is too long.';
  if (draft.skills.length > MACRO_LIMITS.skills) errors.skills = 'Too many skills.';
  else if (draft.skills.some((skill) => skill.length > MACRO_LIMITS.skill || !SKILL.test(skill))) {
    errors.skills = 'Skill names use letters, digits, dots, colons, hyphens and underscores.';
  }
  if (!draft.prompt.trim() && draft.skills.length === 0) errors.content = 'Add a prompt or at least one skill.';
  else if (draft.prompt.length > MACRO_LIMITS.prompt) errors.content = 'The prompt is too long.';
  return errors;
}

/** The stored form of a draft that has no errors. */
export function macroFromDraft(draft: MacroDraft, id: string): Macro {
  const key = normalizeMacroKey(draft.key);
  return { id, name: normalizeMacroName(draft.name), description: draft.description.trim(), prompt: draft.prompt.trim(), skills: [...draft.skills], ...(key ? { key } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stored macros. An entry outside the rules is dropped, never thrown and never repaired. */
export function parseMacros(raw: string | null | undefined): Macro[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const macros: Macro[] = [];
  for (const entry of parsed) {
    if (macros.length >= MACRO_LIMITS.macros) break;
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id || entry.id.length > MACRO_LIMITS.id || typeof entry.name !== 'string') continue;
    const id = entry.id;
    // A stored key that is not one free letter only loses the key: the macro itself still works.
    const key = typeof entry.key === 'string' ? normalizeMacroKey(entry.key) : '';
    const draft: MacroDraft = {
      id,
      name: entry.name,
      description: typeof entry.description === 'string' ? entry.description : '',
      prompt: typeof entry.prompt === 'string' ? entry.prompt : '',
      skills: Array.isArray(entry.skills) ? entry.skills.filter((skill): skill is string => typeof skill === 'string') : [],
      ...(KEY.test(key) && !macros.some((macro) => macro.key === key) ? { key } : {}),
    };
    if (macros.some((macro) => macro.id === id) || Object.keys(macroErrors(draft, macros)).length > 0) continue;
    macros.push(macroFromDraft(draft, id));
  }
  return macros;
}

export interface MacroToken {
  /** Index of the first `/`. */
  readonly start: number;
  /** End of the name (exclusive). */
  readonly end: number;
  readonly macro: Macro;
}

/** The `//name` tokens of known macros, in order. Unknown names stay plain text. */
export function findMacroTokens(text: string, macros: readonly Macro[]): MacroToken[] {
  if (macros.length === 0 || !text.includes('//')) return [];
  const byName = new Map(macros.map((macro) => [macro.name, macro]));
  const tokens: MacroToken[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const name = match[2] ?? '';
    const macro = byName.get(name.toLowerCase());
    if (!macro) continue;
    const start = match.index + (match[1] ?? '').length;
    tokens.push({ start, end: start + 2 + name.length, macro });
  }
  return tokens;
}

/** The token the caret is in or next to, if any. */
export function macroTokenAt(tokens: readonly MacroToken[], caret: number): MacroToken | undefined {
  return tokens.find((token) => caret >= token.start && caret <= token.end);
}

/** A key press, as much of it as the macro list reads. */
export interface MacroKeyPress {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
}

/** The first rows of the list that digits pick: 1 is the first row, 9 the ninth. */
export const MACRO_DIGIT_ROWS = 9;

/**
 * The row a key picks in the macro list `shown`: a digit takes that row of the
 * first nine, a letter takes the macro that holds it as its key. A letter typed
 * in another alphabet counts as the Latin letter on the same physical key, so
 * a macro keyed `a` also answers `ф`. -1 when the key picks nothing.
 */
export function macroShortcutIndex(press: MacroKeyPress, shown: readonly Macro[]): number {
  if (press.ctrlKey || press.metaKey || press.altKey) return -1;
  if (/^[1-9]$/u.test(press.key)) {
    const row = Number(press.key) - 1;
    return row < shown.length ? row : -1;
  }
  if ([...press.key].length !== 1) return -1;
  const typed = press.key.toLowerCase();
  const typedRow = shown.findIndex((macro) => macro.key === typed);
  // Only a letter of another alphabet falls back to its physical key: a Latin layout's letter is what it says.
  if (typedRow >= 0 || !/^\p{L}$/u.test(typed) || /^[a-z]$/u.test(typed)) return typedRow;
  const physical = /^Key([A-Z])$/u.exec(press.code ?? '')?.[1]?.toLowerCase();
  return physical ? shown.findIndex((macro) => macro.key === physical) : -1;
}

/** One line for a menu row or a list: the description, else the first line of the prompt, else the skills. */
export function macroSummary(macro: Macro): string {
  return macro.description || (macro.prompt.trim().split(/\r?\n/u)[0] ?? '') || macro.skills.join(', ');
}
