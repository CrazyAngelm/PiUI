import { describe, expect, it } from 'vitest';
import type { AgentProfile } from '../../../../../contracts/orchestration-v6';
import { checkedCreationProfile, cloudProfile, replacedProfileSettings, usesCloudProfile } from './cloudCreationProfile';

describe('explicit cloud profile replacement', () => {
  it('preserves portable instructions and discloses every removed native setting', () => {
    const profile: AgentProfile = {
      id: 'profile', name: 'Imported agent', harness: 'codex', model: 'native-model', permissionMode: 'read-only',
      instructions: 'Keep instructions', whenToCall: 'For review', inputInstructions: 'Read input', expectedResult: 'Report',
      modelProvider: 'native-provider', reasoning: 'high', serviceTier: 'fast', networkAccess: false,
      baseInstructions: '', resourceRules: [{ kind: 'skill', id: 'review', enabled: true }],
      toolPolicy: { rules: [{ tool: 'shell', decision: 'deny', enforcement: 'native', mandatory: true }] }, allowedSpawnProfileIds: ['child'],
    };
    const capability = checkedCreationProfile({ harness: 'hermes', permissionMode: 'native', model: 'free', models: ['free'] })!;
    const result = cloudProfile(profile, capability);
    expect(profile.harness).toBe('codex');
    expect(result).toEqual({ id: 'profile', name: profile.name, instructions: profile.instructions,
      whenToCall: profile.whenToCall, inputInstructions: profile.inputInstructions, expectedResult: profile.expectedResult,
      harness: 'hermes', model: 'free', permissionMode: 'native', toolPolicy: { rules: [] }, allowedSpawnProfileIds: [] });
    expect(replacedProfileSettings(profile).map(row => row.label)).toEqual([
      'Harness', 'Model', 'Permission mode', 'Model provider', 'Reasoning', 'Speed', 'Network access',
      'Base instructions', 'Tool rules', 'Resource rules', 'Delegation permissions',
    ]);
    expect(usesCloudProfile(result, capability)).toBe(true);
    expect(usesCloudProfile({ ...result, networkAccess: false }, capability)).toBe(false);
    expect(usesCloudProfile(result, null)).toBe(false);
  });
});
