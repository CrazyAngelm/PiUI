import type { HarnessConfiguration } from './types';
export const codexConfiguration: HarnessConfiguration = {
  name: 'Codex', reasoningExamples: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'], speed: true, basePrompt: true,
  permissionModes: ['native', 'read-only', 'workspace-write', 'full-access'], defaultPermission: 'read-only', resourceKinds: ['skill', 'mcp'], skillIdentifier: 'path', nativeTools: [], filesystemSandbox: true, networkAccess: true,
  oneShot: {
    tools: 'read-only-sandbox',
    note: 'Codex cannot turn its tools off. A model call runs in the read-only sandbox without network access, so the model can still read files and run read-only commands.',
  },
  limitations: [
    'Codex cannot limit its tools per agent: only its sandbox and permissions bound them.',
    'With read-only, workspace-write or full-access permissions Codex never asks for approval: actions that would need it, including MCP tools that ask first, are refused.',
    'Network access stays off unless you allow it, and only with read-only or workspace-write permissions.',
  ],
};
