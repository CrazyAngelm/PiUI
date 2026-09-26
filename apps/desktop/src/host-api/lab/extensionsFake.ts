import type { AgentKind, ExtensionSummary } from '../types';
import { apiFailure, LabDecodeFailure } from './labErrors';
import type { LabArgs, LabHandlers } from './labHandlers';
import { hashString } from './labRandom';

/**
 * `list_extensions_v10` / `set_extension_enabled_v10`: separate global
 * inventories per harness, opaque 36-character ids, and the refreshed list as
 * the answer to every change. Nothing is installed or loaded.
 */
function extensionId(agentKind: AgentKind, name: string): string {
  const part = (seed: string) => hashString(`${agentKind}\u0000${name}\u0000${seed}`).toString(16).padStart(8, '0').slice(0, 8);
  return `ext-${part('a')}${part('b')}${part('c')}${part('d')}`;
}

function extension(agentKind: AgentKind, name: string, source: ExtensionSummary['source'], enabled: boolean): ExtensionSummary {
  return { id: extensionId(agentKind, name), agentKind, name, source, enabled };
}

export function demoExtensions(): ExtensionSummary[] {
  return [
    extension('pi', 'permission-guard', 'Global', true),
    extension('pi', 'commit-digest', 'Package', true),
    extension('pi', 'workspace-tools', 'Package', false),
    extension('prime-agent', 'review-workers', 'Global', true),
  ];
}

function agentKind(args: LabArgs): AgentKind {
  const value = args.agentKind;
  if (value === undefined) throw new LabDecodeFailure('missing', 'agentKind', true);
  if (value !== 'pi' && value !== 'prime-agent') throw apiFailure('INVALID_ARGUMENT');
  return value;
}

export function extensionHandlers(inventory: ExtensionSummary[]): LabHandlers {
  const listFor = (kind: AgentKind) => inventory.filter((item) => item.agentKind === kind).map((item) => ({ ...item }));
  return {
    list_extensions_v10: (args) => listFor(agentKind(args)),
    set_extension_enabled_v10: (args) => {
      const kind = agentKind(args);
      const { extensionId: id, enabled } = args;
      if (typeof id !== 'string') throw new LabDecodeFailure('invalid type: expected a string', 'extensionId');
      if (typeof enabled !== 'boolean') throw new LabDecodeFailure('invalid type: expected a boolean', 'enabled');
      if (id.length !== 36 || !id.startsWith('ext-')) throw apiFailure('INVALID_ARGUMENT');
      const target = inventory.find((item) => item.agentKind === kind && item.id === id);
      if (target === undefined) throw apiFailure('NOT_FOUND');
      target.enabled = enabled;
      return listFor(kind);
    },
  };
}
