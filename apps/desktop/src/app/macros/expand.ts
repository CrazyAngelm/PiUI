/**
 * How a macro becomes text for an agent (ADR-060): the syntax of its skills
 * and the message as it is sent. Apart from the rules in `macro.ts`, so the
 * new-chat screen loads this only for a message that has a macro.
 */
import { findMacroTokens, type Macro } from './macro';

/** How the chat's agent is told to use a skill. */
export interface SkillSyntax {
  /** Skills the open chat lists with their exact mention text (Codex `$name`). */
  readonly skills?: readonly { readonly name: string; readonly mention: string }[];
  /** Native `/` commands of the open chat; a skill may be one of them. */
  readonly commands?: readonly { readonly name: string }[];
  /** The agent resolves `$name` mentions; otherwise a skill is a native `/name` command. */
  readonly dollar: boolean;
  /** Stands before a skill's name in its native command: Pi's `skill:`. */
  readonly prefix?: string;
}

/** One skill in the agent's own syntax: its listed mention, its native command, else `$name` or `/name`. */
export function skillInvocation(name: string, syntax: SkillSyntax): string {
  const listed = syntax.skills?.find((skill) => skill.name === name);
  if (listed) return listed.mention;
  const command = syntax.commands?.find((item) => item.name === name || item.name === `skill:${name}`);
  if (command) return `/${command.name}`;
  return syntax.dollar ? `$${name}` : `/${syntax.prefix ?? ''}${name}`;
}

/** What one macro adds to a message: its skills, then its prompt, on one line so a leading `/skill` keeps its arguments. */
export function macroText(macro: Macro, syntax: SkillSyntax): string {
  return [...macro.skills.map((name) => skillInvocation(name, syntax)), macro.prompt.trim()].filter(Boolean).join(' ');
}

/**
 * The message as it is sent: every known `//name` replaced by its macro text.
 * An agent runs a native `/command` only at the start of a message, so skills
 * written that way move there, each once and in order, and the prompts stay
 * where the macros stood. A message that already starts with a command keeps
 * everything in place. The inserted text is not scanned again, so a macro
 * cannot call another.
 */
export function expandMacros(text: string, macros: readonly Macro[], syntax: SkillSyntax): string {
  const tokens = findMacroTokens(text, macros);
  if (tokens.length === 0) return text;
  const hoist = !/^\s*\/[^\s/]/u.test(text);
  const leading: string[] = [];
  let result = '';
  let position = 0;
  for (const token of tokens) {
    const skills = token.macro.skills.map((name) => skillInvocation(name, syntax));
    const inline = hoist ? skills.filter((skill) => !skill.startsWith('/')) : skills;
    if (hoist) for (const skill of skills) if (skill.startsWith('/') && !leading.includes(skill)) leading.push(skill);
    const added = [...inline, token.macro.prompt.trim()].filter(Boolean).join(' ');
    result += text.slice(position, token.start) + added;
    position = token.end;
    // A macro that left nothing in its place leaves no doubled space either.
    if (!added && (text[position] === ' ' || text[position] === '\t')) position += 1;
  }
  result += text.slice(position);
  return leading.length ? `${leading.join(' ')} ${result.trim()}`.trimEnd() : result;
}
