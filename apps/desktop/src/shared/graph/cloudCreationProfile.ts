import type { GraphCreationProfile } from '../../../../../contracts/graph-drafts-v1';
import type { AgentProfile } from '../../../../../contracts/orchestration-v6';

export function checkedCreationProfile(value: GraphCreationProfile | null | undefined): GraphCreationProfile | null {
  if (value === null || value === undefined) return null;
  if (value.harness !== 'hermes' || value.permissionMode !== 'native' || !Array.isArray(value.models)
    || !value.models.length || value.models.some(model => typeof model !== 'string' || !model.trim())
    || !value.models.includes(value.model)) throw new Error('Unsupported graph creation profile.');
  return { harness: value.harness, permissionMode: value.permissionMode, model: value.model, models: [...new Set(value.models)] };
}

/** A fresh native profile, never a merge that silently retains or drops native overrides. */
export function cloudProfile(current: AgentProfile, capability: GraphCreationProfile): AgentProfile {
  return { id: current.id, name: current.name, instructions: current.instructions,
    ...(current.whenToCall === undefined ? {} : { whenToCall: current.whenToCall }),
    ...(current.inputInstructions === undefined ? {} : { inputInstructions: current.inputInstructions }),
    ...(current.expectedResult === undefined ? {} : { expectedResult: current.expectedResult }),
    harness: capability.harness, permissionMode: capability.permissionMode, model: capability.model,
    toolPolicy: { rules: [] }, allowedSpawnProfileIds: [] };
}

/** Settings disclosed before an explicit replacement. Instructions/name/task are preserved. */
export function replacedProfileSettings(profile: AgentProfile): { label: string; value: string }[] {
  const rows = [{ label: 'Harness', value: profile.harness }, { label: 'Model', value: profile.model || '—' }, { label: 'Permission mode', value: profile.permissionMode }];
  if (profile.modelProvider !== undefined) rows.push({ label: 'Model provider', value: profile.modelProvider });
  if (profile.reasoning !== undefined) rows.push({ label: 'Reasoning', value: profile.reasoning });
  if (profile.serviceTier !== undefined) rows.push({ label: 'Speed', value: profile.serviceTier });
  if (profile.networkAccess !== undefined) rows.push({ label: 'Network access', value: String(profile.networkAccess) });
  if (profile.baseInstructions !== undefined) rows.push({ label: 'Base instructions', value: 'Configured' });
  if (profile.toolPolicy.rules.length) rows.push({ label: 'Tool rules', value: String(profile.toolPolicy.rules.length) });
  if (profile.resourceRules?.length) rows.push({ label: 'Resource rules', value: String(profile.resourceRules.length) });
  if (profile.allowedSpawnProfileIds.length) rows.push({ label: 'Delegation permissions', value: String(profile.allowedSpawnProfileIds.length) });
  return rows;
}

export function usesCloudProfile(profile: AgentProfile, capability: GraphCreationProfile | null): boolean {
  return capability !== null && profile.harness === 'hermes' && profile.permissionMode === 'native' && capability.models.includes(profile.model)
    && profile.modelProvider === undefined && profile.reasoning === undefined && profile.serviceTier === undefined
    && profile.baseInstructions === undefined && profile.networkAccess === undefined && !profile.resourceRules?.length
    && !profile.toolPolicy.rules.length && !profile.allowedSpawnProfileIds.length;
}
