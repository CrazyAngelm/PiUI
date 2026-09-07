import type { HarnessConfiguration } from './types';
export const hermesConfiguration: HarnessConfiguration = {
  name: 'Hermes', reasoningExamples: [], speed: false, basePrompt: false,
  permissionModes: ['native'], defaultPermission: 'native', resourceKinds: [],
  skillIdentifier: 'name', nativeTools: [], filesystemSandbox: false,
};
