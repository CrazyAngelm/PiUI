import type { HarnessConfiguration } from './types';
export const hermesConfiguration: HarnessConfiguration = {
  name: 'Hermes', reasoningExamples: [], speed: false, basePrompt: false,
  permissionModes: ['native'], defaultPermission: 'native', resourceKinds: [], networkAccess: false,
  skillIdentifier: 'name', nativeTools: [], filesystemSandbox: false,
  limitations: [
    'Uses its own permission settings; PiUI cannot make it read-only.',
    'Tools and delegation cannot be limited per agent.',
    'A running turn cannot be steered; follow-ups wait for it to end.',
    'Cannot run a single model call read-only.',
  ],
};
