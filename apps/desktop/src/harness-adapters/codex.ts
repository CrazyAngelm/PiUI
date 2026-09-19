import type { HarnessConfiguration } from './types';
export const codexConfiguration: HarnessConfiguration = {
  name: 'Codex', reasoningExamples: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'], speed: true, basePrompt: true,
  permissionModes: ['native', 'read-only', 'workspace-write', 'full-access'], defaultPermission: 'read-only', resourceKinds: ['skill', 'mcp'], skillIdentifier: 'path', nativeTools: [], filesystemSandbox: true, networkAccess: true,
};
