import type { AgentProfile } from '../../../../contracts/orchestration-v6';
import { harnessConfiguration } from './index';

type Portable = Pick<AgentProfile, 'harness' | 'permissionMode' | 'model'> & Partial<AgentProfile>;

/**
 * Settings a profile keeps when it moves to another harness through an
 * explicit UI choice (template, new agent, harness picker). Settings the
 * target harness cannot honour are reset to its native defaults instead of
 * being sent and rejected; imports never use this and keep failing loudly.
 */
export function profileForHarness<T extends Portable>(profile: T, harness: AgentProfile['harness']): T {
  const next = harnessConfiguration(harness);
  const moved = profile.harness !== harness;
  const {
    serviceTier,
    baseInstructions,
    networkAccess,
    reasoning,
    resourceRules,
    modelProvider,
    ...rest
  } = profile;
  return {
    ...rest,
    harness,
    model: moved ? '' : profile.model,
    permissionMode: next.permissionModes.includes(profile.permissionMode) ? profile.permissionMode : next.defaultPermission,
    ...(next.speed ? { serviceTier: moved ? 'standard' : (serviceTier ?? 'standard') } : {}),
    ...(next.basePrompt && baseInstructions !== undefined ? { baseInstructions } : {}),
    ...(next.networkAccess && networkAccess !== undefined ? { networkAccess } : {}),
    ...(!moved && reasoning !== undefined ? { reasoning } : {}),
    ...(!moved && resourceRules !== undefined ? { resourceRules } : {}),
    ...(!moved && modelProvider !== undefined ? { modelProvider } : {}),
  } as T;
}
