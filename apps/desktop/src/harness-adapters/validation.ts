import type { AgentProfile } from '../../../../contracts/orchestration-v4';
import { harnessConfigurations } from './index';

/** Static file checks only. The native host remains authoritative at launch. */
export function profileConfigurationErrors(id: string, profile: Omit<AgentProfile, 'id' | 'allowedSpawnProfileIds'>): string[] {
  const errors: string[] = [];
    const configuration = harnessConfigurations[profile.harness];
    if (!configuration.permissionModes.includes(profile.permissionMode)) errors.push(`${id}: unsupported file permissions.`);
    if (profile.serviceTier !== undefined && !configuration.speed) errors.push(`${id}: speed is not supported.`);
    if (profile.baseInstructions !== undefined && !configuration.basePrompt) errors.push(`${id}: base prompt replacement is not supported.`);
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
    }
  return errors;
}
