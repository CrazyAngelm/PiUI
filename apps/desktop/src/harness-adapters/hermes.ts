import type { HarnessConfiguration } from './types';
export const hermesConfiguration: HarnessConfiguration = {
  name: 'Hermes', reasoningExamples: [], speed: false, basePrompt: false,
  permissionModes: ['native'], defaultPermission: 'native', resourceKinds: [], networkAccess: false,
  skillIdentifier: 'name', nativeTools: [], filesystemSandbox: false,
  limitations: [
    'Hermes uses its own permission settings: PiUI cannot make it read-only or limit its writes.',
    'Hermes cannot limit its tools or delegation per agent.',
    'Hermes cannot steer a running turn; follow-up messages wait until it ends.',
    'Hermes cannot run a single model call read-only.',
  ],
};
