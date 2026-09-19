import type { HarnessConfiguration } from './types';
export const hermesConfiguration: HarnessConfiguration = {
  name: 'Hermes', reasoningExamples: [], speed: false, basePrompt: false,
  permissionModes: ['native'], defaultPermission: 'native', resourceKinds: [], networkAccess: false,
  skillIdentifier: 'name', nativeTools: [], filesystemSandbox: false,
};
