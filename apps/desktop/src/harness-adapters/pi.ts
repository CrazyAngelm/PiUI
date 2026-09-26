import type { HarnessConfiguration } from './types';
export const piConfiguration: HarnessConfiguration = {
  name: 'Pi', reasoningExamples: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'], speed: false, basePrompt: false,
  permissionModes: ['native', 'read-only', 'full-access'], defaultPermission: 'native', resourceKinds: [], skillIdentifier: 'name', nativeTools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'], filesystemSandbox: false, networkAccess: false,
  oneShot: {
    tools: 'disabled',
    note: 'Pi starts a model call with no tools and no extensions (--no-tools --no-extensions).',
  },
  limitations: [
    "Read-only allows only the read, grep, find and ls tools. It is Pi's tool allowlist, not a sandbox.",
    'Pi has no workspace-write mode: choose read-only or full access.',
    'Pi cannot restrict network access.',
  ],
};
