import { describe, expect, it } from 'vitest';
import type { RuntimeCommand } from '../../host-api/types';
import {
  applyPiUiCommandContributions,
  commandDraft,
  filterRuntimeCommands,
  runtimeCommandKey,
  runtimeCommandProvenance,
  slashCommandQuery,
} from './runtimeCommands';

const commands: RuntimeCommand[] = [
  { name: 'agents', description: 'Inspect subagents', source: 'extension', scope: 'user', origin: 'package' },
  { name: 'afterdone-list', description: 'List deferred tasks', source: 'extension', scope: 'user', origin: 'package' },
  { name: 'lsp', description: 'Show language server status', source: 'extension', scope: 'user', origin: 'package' },
  { name: 'skill:browser-use', description: 'Automate a browser', source: 'skill', scope: 'user', origin: 'top-level' },
];

describe('runtime commands', () => {
  it('finds slash commands by name and description with stable provenance', () => {
    expect(filterRuntimeCommands(commands, '/age').map((command) => command.name)).toEqual(['agents']);
    expect(filterRuntimeCommands(commands, 'language').map((command) => command.name)).toEqual(['lsp']);
    expect(filterRuntimeCommands(commands, 'skill').map((command) => command.name)).toEqual(['skill:browser-use']);
    expect(filterRuntimeCommands(
      [...commands, { ...commands[0], source: 'prompt' as const, scope: 'project' as const }],
      '/agents',
    )).toEqual([]);
  });

  it('opens slash suggestions only for the first unfinished command token', () => {
    expect(slashCommandQuery('/ag')).toBe('ag');
    expect(slashCommandQuery('/')).toBe('');
    expect(slashCommandQuery('/agents ')).toBeUndefined();
    expect(slashCommandQuery('explain /agents')).toBeUndefined();
    expect(slashCommandQuery('/agents\nnext')).toBeUndefined();
  });

  it('inserts the canonical Pi invocation name without executing it', () => {
    expect(commandDraft(commands[0])).toBe('/agents ');
    expect(commandDraft({ ...commands[0], name: 'review:1' })).toBe('/review:1 ');
  });

  it('applies declarative command labels only to an unambiguous extension command', () => {
    const decorated = applyPiUiCommandContributions(commands, [{
      extensionId: 'local.test',
      extensionName: 'Test package',
      id: 'local.test.agents',
      title: 'Agent activity',
      description: 'Inspect active workers.',
      commandName: 'agents',
    }]);
    expect(decorated[0]?.description).toBe('Test package — Agent activity: Inspect active workers.');
    expect(decorated[1]).toBe(commands[1]);

    const ambiguous = applyPiUiCommandContributions(
      [...commands, { ...commands[0], scope: 'project' }],
      [{
        extensionId: 'local.test', extensionName: 'Test package', id: 'local.test.agents',
        title: 'Agent activity', commandName: 'agents',
      }],
    );
    expect(ambiguous[0]).toBe(commands[0]);
  });

  it('labels path-free provenance and keeps same-name sources distinct', () => {
    expect(runtimeCommandProvenance(commands[0])).toBe('Package extension');
    expect(runtimeCommandProvenance(commands[3])).toBe('Global skill');
    const temporary = { ...commands[0], scope: 'temporary' as const, origin: undefined };
    expect(runtimeCommandProvenance(temporary)).toBe('Temporary extension');
    expect(runtimeCommandKey(commands[0])).not.toBe(runtimeCommandKey(temporary));
  });
});
