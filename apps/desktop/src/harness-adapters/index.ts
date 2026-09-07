import type { HarnessConfigurations } from './types';
import { codexConfiguration } from './codex';
import { primeConfiguration } from './prime';
import { hermesConfiguration } from './hermes';
import { piConfiguration } from './pi';
export const harnessConfigurations: HarnessConfigurations = { codex: codexConfiguration, 'prime-agent': primeConfiguration, pi: piConfiguration, hermes: hermesConfiguration };
export const permissionLabels = { native: 'Native permissions', 'read-only': 'Read-only', 'workspace-write': 'Workspace write', 'full-access': 'Full access' } as const;
