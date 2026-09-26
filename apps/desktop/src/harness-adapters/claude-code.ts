import type { HarnessConfiguration } from './types';

/**
 * Claude Code on the user's own Claude subscription (ADR-029). Presentation
 * metadata only: the host enforces every setting before a native start.
 *
 * - Effort levels are the adapter's vocabulary; the native model catalog
 *   decides which of them a selected model supports.
 * - Fast mode is never offered: it can use paid extra usage.
 * - Tools restrict Claude Code's built-in set (`--tools`). User MCP servers,
 *   skills and plugins come from the user's own Claude Code configuration and
 *   cannot be overridden per session; a tool policy excludes user MCP servers.
 *   Managed runs always disable the native Agent tool and delegate through the
 *   PiUI coordinator instead.
 * - Permission presets are Claude Code's own permission engine, not an OS
 *   sandbox (see `limitations`).
 */
export const claudeCodeConfiguration: HarnessConfiguration = {
  name: 'Claude Code', reasoningExamples: ['low', 'medium', 'high', 'xhigh', 'max'], speed: false, basePrompt: false,
  permissionModes: ['native', 'read-only', 'workspace-write', 'full-access'], defaultPermission: 'read-only',
  resourceKinds: [], skillIdentifier: 'name',
  nativeTools: [
    'AskUserQuestion', 'Bash', 'Edit', 'ExitPlanMode', 'Glob', 'Grep', 'NotebookEdit', 'PowerShell', 'Read', 'Skill',
    'TaskOutput', 'TaskStop', 'TodoWrite', 'WebFetch', 'WebSearch', 'Write', 'workspace',
  ],
  filesystemSandbox: false, networkAccess: false,
  oneShot: {
    tools: 'disabled',
    note: 'Claude Code starts a model call with no tools and no MCP servers (--tools "" --strict-mcp-config).',
  },
  limitations: [
    'Runs only on your Claude subscription. API keys, cloud providers, fast mode and paid extra usage are never used.',
    "Read-only and workspace-write can only deny Claude Code permission prompts, so prompted tools such as Bash never run there. This is Claude Code's permission engine, not a sandbox.",
    'Skills, MCP servers and plugins come from your Claude Code configuration and cannot be switched per agent.',
    'A step fails before it starts when Claude Code is not signed in: run `claude` in a terminal and use /login.',
  ],
};

/** Effort values the Claude Code adapter accepts at all. */
export const CLAUDE_CODE_EFFORT_LEVELS: readonly string[] = claudeCodeConfiguration.reasoningExamples;
