import type { AgentProfile } from '../../../../contracts/orchestration-v6';
import { CLAUDE_CODE_EFFORT_LEVELS } from './claude-code';
import { harnessConfigurations } from './index';

/** Claude Code asks before running these; read-only and workspace-write can only deny. */
const CLAUDE_PROMPTED_COMMAND_TOOLS = ['Bash', 'PowerShell'];
const CLAUDE_FILE_WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

/** Static file checks only. The native host remains authoritative at launch. */
export function profileConfigurationErrors(id: string, profile: Omit<AgentProfile, 'id' | 'allowedSpawnProfileIds'>): string[] {
  const errors: string[] = [];
    const configuration = harnessConfigurations[profile.harness];
    if (!configuration.permissionModes.includes(profile.permissionMode)) errors.push(`${id}: unsupported file permissions.`);
    if (profile.serviceTier !== undefined && !configuration.speed) errors.push(`${id}: speed is not supported.`);
    if (profile.baseInstructions !== undefined && !configuration.basePrompt) errors.push(`${id}: base prompt replacement is not supported.`);
    if (profile.networkAccess && (!configuration.networkAccess || !['read-only', 'workspace-write'].includes(profile.permissionMode))) errors.push(`${id}: network access is not supported with these permissions.`);
    const resources = new Set<string>();
    for (const rule of profile.resourceRules ?? []) {
      if (!configuration.resourceKinds.includes(rule.kind)) errors.push(`${id}: unsupported resource kind.`);
      if (rule.kind === 'skill' && configuration.skillIdentifier === 'path' && !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(rule.id)) errors.push(`${id}: skill requires an absolute path.`);
      if (rule.kind === 'mcp' && !/^[A-Za-z0-9_-]+$/.test(rule.id)) errors.push(`${id}: invalid MCP server name.`);
      const key = JSON.stringify([rule.kind, rule.id]);
      if (resources.has(key)) errors.push(`${id}: duplicate resource rule.`);
      resources.add(key);
    }
    for (const rule of profile.toolPolicy.rules) {
      if (rule.enforcement === 'native' && !configuration.nativeTools.includes(rule.tool)) errors.push(`${id}: unknown native tool.`);
      if (rule.mandatory && ['advisory', 'unsupported'].includes(rule.enforcement)) errors.push(`${id}: mandatory policy cannot be advisory or unsupported.`);
      if (profile.harness === 'claude-code' && rule.enforcement === 'native' && rule.decision === 'allow'
        && ((['read-only', 'workspace-write'].includes(profile.permissionMode) && CLAUDE_PROMPTED_COMMAND_TOOLS.includes(rule.tool))
          || (profile.permissionMode === 'read-only' && CLAUDE_FILE_WRITE_TOOLS.includes(rule.tool)))) {
        errors.push(`${id}: ${rule.tool} cannot run with these Claude Code permissions.`);
      }
    }
    // The adapter's effort vocabulary; the native catalog narrows it per model.
    if (profile.harness === 'claude-code' && profile.reasoning !== undefined && !CLAUDE_CODE_EFFORT_LEVELS.includes(profile.reasoning)) {
      errors.push(`${id}: unsupported Claude Code effort level.`);
    }
    if (profile.harness === 'claude-code' && profile.modelProvider !== undefined && profile.modelProvider !== 'anthropic') {
      errors.push(`${id}: Claude Code runs only Anthropic models.`);
    }
  return errors;
}
