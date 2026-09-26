import type { HarnessConfiguration, HarnessConfigurations } from './types';
import type { Harness } from '../../../../contracts/orchestration-v6';
import { BUILTIN_HARNESSES, isAcpHarness, isBuiltinHarness } from '../../../../contracts/harness-identity-v2';
import { codexConfiguration } from './codex';
import { primeConfiguration } from './prime';
import { hermesConfiguration } from './hermes';
import { piConfiguration } from './pi';
import { claudeCodeConfiguration } from './claude-code';
import { acpConfiguration } from './acp';
export const harnessConfigurations: HarnessConfigurations = { codex: codexConfiguration, 'prime-agent': primeConfiguration, pi: piConfiguration, hermes: hermesConfiguration, 'claude-code': claudeCodeConfiguration };
export const permissionLabels = { native: 'Native permissions', 'read-only': 'Read-only', 'workspace-write': 'Workspace write', 'full-access': 'Full access' } as const;

/** The manifest of any harness identity: built-in adapters, else the generic ACP manifest. */
export function harnessConfiguration(harness: Harness): HarnessConfiguration {
  return isBuiltinHarness(harness) ? harnessConfigurations[harness] : acpConfiguration;
}

/** Built-in adapters followed by the ACP agents in the host catalog, for profile pickers. */
export function profileHarnesses(catalog: readonly { kind: Harness }[]): Harness[] {
  return [...BUILTIN_HARNESSES, ...catalog.map((summary) => summary.kind).filter(isAcpHarness)];
}
