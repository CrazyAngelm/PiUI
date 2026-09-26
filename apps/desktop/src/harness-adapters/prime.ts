import type { HarnessConfiguration } from './types';
export const primeConfiguration: HarnessConfiguration = {
  name: 'Prime Agent', reasoningExamples: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'], speed: true, basePrompt: false,
  permissionModes: ['native'], defaultPermission: 'native', resourceKinds: ['skill'], skillIdentifier: 'name', nativeTools: ['ipython', 'workspace'], filesystemSandbox: false, networkAccess: false,
  limitations: [
    'Uses its own permission settings; PiUI cannot make it read-only.',
    'Its approval prompts are not shown in PiUI.',
    'Only skills can be switched per agent, not MCP servers.',
    'Cannot run a single model call read-only.',
  ],
};
