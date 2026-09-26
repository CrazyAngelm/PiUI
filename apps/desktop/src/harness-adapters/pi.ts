import { COMPOSER_SUPPORT } from './composer';
import type { HarnessConfiguration } from './types';
export const piConfiguration: HarnessConfiguration = {
  name: 'Pi', reasoningExamples: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'], speed: false, basePrompt: false,
  permissionModes: ['native', 'read-only', 'full-access'], defaultPermission: 'native', resourceKinds: [], skillIdentifier: 'name', nativeTools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'], filesystemSandbox: false, networkAccess: false,
  oneShot: {
    tools: 'disabled',
    note: 'Pi starts a model call with no tools and no extensions (--no-tools --no-extensions).',
  },
  composer: COMPOSER_SUPPORT.pi,
  limitations: [
    'Read-only allows only read, grep, find and ls: a tool list, not a sandbox.',
    'No workspace-write mode: choose read-only or full access.',
    'Network access cannot be restricted.',
  ],
};
