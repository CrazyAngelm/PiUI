import type { HarnessConfiguration } from './types';
export const primeConfiguration: HarnessConfiguration = {
  name: 'Prime Agent', reasoningExamples: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'], speed: false, basePrompt: false,
  permissionModes: ['native'], defaultPermission: 'native', resourceKinds: ['skill'], skillIdentifier: 'name', nativeTools: ['ipython', 'workspace'], filesystemSandbox: false,
};
