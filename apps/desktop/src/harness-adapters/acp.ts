import type { HarnessConfiguration } from './types';

/**
 * Generic Agent Client Protocol agent (ADR-034). Presentation metadata only:
 * the host and the ACP bridge enforce every setting before a native start.
 *
 * ACP lets a client pick the agent's advertised model, reasoning level
 * (`thought_level` option) and session mode, and answer its permission
 * requests. It has no per-session tool, skill, MCP, file-permission, network
 * or speed restriction, so those settings are not offered and a profile that
 * requires one fails before the agent starts. Reasoning values are validated
 * against the agent's own option at start; the examples list stays empty.
 */
export const acpConfiguration: HarnessConfiguration = {
  name: 'ACP agent', reasoningExamples: [], speed: false, basePrompt: false,
  permissionModes: ['native'], defaultPermission: 'native',
  resourceKinds: [], skillIdentifier: 'name', nativeTools: [],
  filesystemSandbox: false, networkAccess: false,
  limitations: [
    'The agent keeps its own permission, tool and MCP settings. PiUI answers its permission requests but cannot restrict its tools or files.',
    'Instructions are sent with the first message; the agent keeps its own system prompt.',
  ],
};

/** An ACP profile with this model keeps the agent's own configured model. */
export const ACP_DEFAULT_MODEL = 'default';
