import { hostInvoke, type HostInvoke } from './transport';
import type { AgentKind, ExtensionSummary } from './types';

/**
 * Global Pi and Prime Agent extension inventories (versioned v10 routes).
 * Each harness keeps its own configuration root; the host changes one
 * extension through that harness's own settings mechanism and returns the
 * refreshed list. Native paths never cross IPC: ids are host-derived hashes.
 * Project-local extensions are not listed; a harness only discovers them
 * after the user trusts that folder.
 */
export type ExtensionHarness = Extract<AgentKind, 'pi' | 'prime-agent'>;

const LIST_FAILED = 'Could not read the installed extensions. Try again.';
const CHANGE_FAILED = 'Could not change the extension. Its previous state is kept.';

export class ExtensionsError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ExtensionsError';
  }
}

function codeOf(cause: unknown): string {
  let value: unknown = cause;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      value = undefined;
    }
  }
  return typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string' ? value.code : 'UNKNOWN';
}

function isSummaryList(value: unknown, harness: ExtensionHarness): value is ExtensionSummary[] {
  return Array.isArray(value) && value.every((item: unknown) =>
    typeof item === 'object' && item !== null
    && typeof (item as ExtensionSummary).id === 'string'
    && typeof (item as ExtensionSummary).name === 'string'
    && typeof (item as ExtensionSummary).enabled === 'boolean'
    && (item as ExtensionSummary).agentKind === harness);
}

export interface ExtensionsClient {
  list(harness: ExtensionHarness): Promise<ExtensionSummary[]>;
  setEnabled(harness: ExtensionHarness, extensionId: string, enabled: boolean): Promise<ExtensionSummary[]>;
}

export function createExtensionsClient(invoke: HostInvoke): ExtensionsClient {
  async function call(command: string, args: Record<string, unknown>, harness: ExtensionHarness, failure: string): Promise<ExtensionSummary[]> {
    let result: unknown;
    try {
      result = await invoke<unknown>(command, args);
    } catch (error) {
      throw new ExtensionsError(codeOf(error), failure);
    }
    if (!isSummaryList(result, harness)) throw new ExtensionsError('INVALID_RESPONSE', failure);
    return result;
  }
  return {
    list: (harness) => call('list_extensions_v10', { agentKind: harness }, harness, LIST_FAILED),
    setEnabled: (harness, extensionId, enabled) =>
      call('set_extension_enabled_v10', { agentKind: harness, extensionId, enabled }, harness, CHANGE_FAILED),
  };
}

export const extensionsHost: ExtensionsClient = createExtensionsClient(hostInvoke);
