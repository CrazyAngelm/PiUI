import { describe, expect, it } from 'vitest';
import type { AgentProfile } from '../../../../contracts/orchestration-v6';
import { profileForHarness } from './normalize';
import { profileConfigurationErrors } from './validation';

const codex: AgentProfile = {
  id: 'p',
  name: 'Developer',
  harness: 'codex',
  model: 'gpt-5',
  modelProvider: 'openai',
  permissionMode: 'workspace-write',
  networkAccess: true,
  instructions: 'Be exact',
  baseInstructions: '',
  reasoning: 'high',
  serviceTier: 'fast',
  toolPolicy: { rules: [] },
  resourceRules: [{ kind: 'mcp', id: 'github', enabled: false }],
  allowedSpawnProfileIds: [],
};

describe('profileForHarness', () => {
  it('drops settings the target harness cannot honour and resets the model', () => {
    const pi = profileForHarness(codex, 'pi');
    expect(pi.harness).toBe('pi');
    expect(pi.model).toBe('');
    expect(pi).not.toHaveProperty('serviceTier');
    expect(pi).not.toHaveProperty('baseInstructions');
    expect(pi).not.toHaveProperty('reasoning');
    expect(pi).not.toHaveProperty('resourceRules');
    expect(pi.instructions).toBe('Be exact');
    const { id, allowedSpawnProfileIds, ...portable } = { ...pi, model: 'claude-lab-sonnet' };
    expect(id).toBe('p');
    expect(allowedSpawnProfileIds).toEqual([]);
    expect(profileConfigurationErrors('p', portable)).toEqual([]);
  });

  it('keeps everything when the harness does not change', () => {
    expect(profileForHarness(codex, 'codex')).toEqual(codex);
  });

  it('starts speed at standard on harnesses that support it', () => {
    const moved = profileForHarness({ ...codex, harness: 'pi', serviceTier: undefined }, 'codex');
    expect(moved.serviceTier).toBe('standard');
  });

  it('moves to an ACP agent with native permissions and nothing the protocol cannot enforce', () => {
    const gemini = profileForHarness(codex, 'acp:gemini-cli');
    expect(gemini).toMatchObject({ harness: 'acp:gemini-cli', model: '', permissionMode: 'native', instructions: 'Be exact' });
    for (const key of ['serviceTier', 'baseInstructions', 'networkAccess', 'reasoning', 'resourceRules', 'modelProvider']) {
      expect(gemini, key).not.toHaveProperty(key);
    }
    const { id: _id, allowedSpawnProfileIds: _spawn, ...portable } = { ...gemini, model: 'default' };
    expect(profileConfigurationErrors('gemini', portable)).toEqual([]);
    expect(profileConfigurationErrors('gemini', { ...portable, permissionMode: 'read-only' })).toEqual(['gemini: unsupported file permissions.']);
  });
});

describe('harnessConfiguration', () => {
  it('returns built-in manifests and one generic manifest for every ACP agent', async () => {
    const { harnessConfiguration, harnessConfigurations, profileHarnesses } = await import('./index');
    const { acpConfiguration } = await import('./acp');
    expect(harnessConfiguration('codex')).toBe(harnessConfigurations.codex);
    expect(harnessConfiguration('acp:gemini-cli')).toBe(acpConfiguration);
    expect(harnessConfiguration('acp:other-agent')).toBe(acpConfiguration);
    expect(acpConfiguration).toMatchObject({ permissionModes: ['native'], speed: false, basePrompt: false, networkAccess: false, filesystemSandbox: false, nativeTools: [], resourceKinds: [] });
    expect(acpConfiguration.oneShot).toBeUndefined();
    expect(profileHarnesses([{ kind: 'codex' }, { kind: 'acp:gemini-cli' }])).toEqual(['pi', 'prime-agent', 'codex', 'hermes', 'claude-code', 'acp:gemini-cli']);
  });
});
