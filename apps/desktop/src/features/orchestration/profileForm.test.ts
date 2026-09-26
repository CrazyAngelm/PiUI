import { describe, expect, it } from 'vitest';
import type { AgentProfile } from '../../../../../contracts/orchestration-v6';
import {
  createProfileDraft,
  newToolRule,
  profileFromDraft,
  spawnProfileOptions,
  validateProfileDraft,
} from './profileForm';

const profile: AgentProfile = {
  id: 'profile-a',
  name: 'Planner',
  harness: 'pi',
  modelProvider: 'local',
  model: 'pi-model',
  permissionMode: 'native',
  instructions: 'Plan carefully.',
  toolPolicy: { rules: [{ tool: 'read', decision: 'allow', enforcement: 'native', mandatory: true }] },
  allowedSpawnProfileIds: ['profile-b'],
};

describe('profile form helpers', () => {
  it('round trips a Hermes profile without advertising unsupported speed settings', () => {
    const hermes: AgentProfile = { ...profile, harness: 'hermes', model: 'hermes-model', modelProvider: undefined, toolPolicy: { rules: [] } };
    const draft = createProfileDraft(hermes);
    expect(validateProfileDraft(draft).valid).toBe(true);
    expect(profileFromDraft(draft)).toEqual(hermes);
    draft.model = '';
    expect(validateProfileDraft(draft).valid).toBe(false);
  });
  it('round trips a Claude Code profile and never stores a speed for it', () => {
    const claude: AgentProfile = {
      ...profile, harness: 'claude-code', modelProvider: 'anthropic', model: 'sonnet', reasoning: 'xhigh', permissionMode: 'read-only',
      toolPolicy: { rules: [{ tool: 'Read', decision: 'allow', enforcement: 'native', mandatory: true }] },
    };
    const draft = createProfileDraft(claude);
    expect(validateProfileDraft(draft).valid).toBe(true);
    expect(profileFromDraft(draft)).toEqual(claude);
    draft.serviceTier = 'fast';
    expect(profileFromDraft(draft).serviceTier, 'fast mode can use paid extra usage').toBeUndefined();
  });
  it('preserves invocation, input and output descriptions independently of instructions', () => {
    const original = { ...profile, whenToCall: 'After implementation', inputInstructions: 'Diff and evidence', expectedResult: 'Actionable review' };
    expect(profileFromDraft(createProfileDraft(original))).toEqual(original);
  });
  it('uses the native base prompt by default and preserves imported replacements', () => {
    const draft = createProfileDraft(undefined, () => 'base-default');
    draft.harness = 'codex';
    expect(draft.replaceBasePrompt).toBe(false);
    expect(profileFromDraft(draft).baseInstructions).toBeUndefined();
    const imported = { ...profile, harness: 'codex' as const, baseInstructions: 'Existing custom instructions' };
    expect(profileFromDraft(createProfileDraft(imported)).baseInstructions).toBe(imported.baseInstructions);
  });
  it('distinguishes an empty replacement from native instructions and never passes it to another harness', () => {
    const draft = createProfileDraft({ ...profile, harness: 'codex', baseInstructions: '' });
    expect(draft.replaceBasePrompt).toBe(true);
    expect(profileFromDraft(draft).baseInstructions).toBe('');
    draft.replaceBasePrompt = false;
    expect(profileFromDraft(draft).baseInstructions).toBeUndefined();
    draft.replaceBasePrompt = true;
    draft.harness = 'prime-agent';
    expect(profileFromDraft(draft).baseInstructions).toBeUndefined();
  });
  it('creates a new, unsaved profile draft with a generated opaque id and native permissions', () => {
    const draft = createProfileDraft(undefined, () => 'generated-id');

    expect(draft).toMatchObject({
      id: 'generated-id', harness: 'pi', permissionMode: 'native',
      name: '', model: '', instructions: '', toolRules: [], allowedSpawnProfileIds: [],
    });
    expect(validateProfileDraft(draft)).toEqual({ valid: false, errors: ['Enter a profile name.', 'Enter a model.'] });
  });

  it('projects an edited draft into an immutable save contract without mutating its source', () => {
    const draft = createProfileDraft(profile);
    draft.name = ' Planner updated ';
    draft.modelProvider = ' provider ';
    draft.allowedSpawnProfileIds = ['profile-b', 'profile-b', draft.id];

    const saved = profileFromDraft(draft);

    expect(saved).toEqual({
      ...profile,
      name: 'Planner updated', modelProvider: 'provider',
      allowedSpawnProfileIds: ['profile-b', 'profile-b', 'profile-a'],
    });
    expect(draft.name).toBe(' Planner updated ');
    expect(profile.toolPolicy.rules[0]?.tool).toBe('read');
  });

  it('rejects incomplete declared rules while retaining a draft that can be corrected', () => {
    const draft = createProfileDraft(profile);
    draft.toolRules = [newToolRule()];

    expect(validateProfileDraft(draft)).toEqual({
      valid: false,
      errors: ['Name every declared tool rule or remove it.'],
    });
    draft.toolRules = [{ ...draft.toolRules[0]!, tool: 'search' }];
    expect(validateProfileDraft(draft)).toEqual({ valid: true, errors: [] });
  });

  it('requires explicit compatible Codex permissions for network access', () => {
    const draft = createProfileDraft({ ...profile, harness: 'codex', permissionMode: 'workspace-write', networkAccess: true });
    expect(validateProfileDraft(draft)).toEqual({ valid: true, errors: [] });
    expect(profileFromDraft(draft).networkAccess).toBe(true);
    draft.harness = 'pi';
    expect(validateProfileDraft(draft).errors).toContain('Network access requires Codex read-only or workspace-write permissions.');
  });

  it('keeps recursive and repeated saved spawn references available for explicit user choice', () => {
    const other = { ...profile, id: 'profile-b', name: 'Worker' };
    expect(spawnProfileOptions([profile, other], profile.id)).toEqual([profile, other]);
  });
});
