import type { HarnessConfiguration } from './types';
export const primeConfiguration: HarnessConfiguration = {
  name: 'Prime Agent', reasoningExamples: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'], speed: true, basePrompt: false,
  permissionModes: ['native'], defaultPermission: 'native', resourceKinds: ['skill'], skillIdentifier: 'name', nativeTools: ['ipython', 'workspace'], filesystemSandbox: false, networkAccess: false,
  limitations: [
    'Prime Agent uses its own permission settings: PiUI cannot make it read-only or limit its writes.',
    'Approval prompts of Prime Agent are not shown in PiUI.',
    'Only skills can be switched per agent; MCP servers cannot.',
    'Prime Agent cannot run a single model call read-only.',
  ],
};
