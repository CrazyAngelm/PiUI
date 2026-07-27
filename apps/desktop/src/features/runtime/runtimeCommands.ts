import type { PiUiCommandContribution, RuntimeCommand } from '../../host-api/types';

const MAX_COMMAND_RESULTS = 20;

function normalizedQuery(query: string): string {
  return query.trim().replace(/^\//, '').toLocaleLowerCase();
}

/** Filters Pi-reported commands without rewriting their canonical invocation names. */
export function filterRuntimeCommands(
  commands: readonly RuntimeCommand[],
  query: string,
  limit = MAX_COMMAND_RESULTS,
): RuntimeCommand[] {
  const needle = normalizedQuery(query);
  const nameOnly = query.trim().startsWith('/');
  const nameCounts = commands.reduce((counts, command) => {
    counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  return commands
    .filter((command) => nameCounts.get(command.name) === 1)
    .map((command, index) => {
      const name = command.name.toLocaleLowerCase();
      const description = command.description?.toLocaleLowerCase() ?? '';
      const score = needle.length === 0
        ? 2
        : name.startsWith(needle)
          ? 0
          : name.includes(needle)
            ? 1
            : !nameOnly && description.includes(needle)
              ? 2
              : Number.POSITIVE_INFINITY;
      return { command, index, score };
    })
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, Math.max(0, limit))
    .map((candidate) => candidate.command);
}

/** Applies unambiguous declarative labels without changing invocation identity. */
export function applyPiUiCommandContributions(
  commands: readonly RuntimeCommand[],
  contributions: readonly PiUiCommandContribution[],
): RuntimeCommand[] {
  return commands.map((command) => {
    if (command.source !== 'extension') return command;
    const sameNameCommands = commands.filter((candidate) => candidate.name === command.name);
    const matches = contributions.filter((contribution) => contribution.commandName === command.name);
    if (sameNameCommands.length !== 1 || matches.length !== 1) return command;
    const contribution = matches[0];
    const detail = contribution.description ?? command.description;
    return {
      ...command,
      description: detail === undefined
        ? `${contribution.extensionName} — ${contribution.title}`
        : `${contribution.extensionName} — ${contribution.title}: ${detail}`,
    };
  });
}

/** Returns the unfinished first slash token, or undefined outside slash completion. */
export function slashCommandQuery(draft: string): string | undefined {
  if (draft.includes('\n')) return undefined;
  const match = draft.match(/^\/([^\s]*)$/u);
  return match?.[1];
}

/** Inserts a command for explicit user review; selection never invokes Pi by itself. */
export function commandDraft(command: RuntimeCommand): string {
  return `/${command.name} `;
}

/** Stable identity for same-name commands reported from distinct Pi sources. */
export function runtimeCommandKey(command: RuntimeCommand): string {
  return [command.name, command.source, command.scope ?? '', command.origin ?? ''].join('\u0000');
}

/** Human-readable provenance without exposing Pi's native source paths. */
export function runtimeCommandProvenance(command: RuntimeCommand): string {
  const location = command.scope === 'temporary'
    ? 'Temporary'
    : command.origin === 'package'
      ? 'Package'
      : command.origin === 'top-level'
        ? 'Global'
        : command.scope === 'project'
          ? 'Project'
          : command.scope === 'user'
            ? 'User'
            : undefined;
  const source = command.source.slice(0, 1).toLocaleUpperCase() + command.source.slice(1);
  return location === undefined ? source : `${location} ${command.source}`;
}
