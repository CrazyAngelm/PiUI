import { describe, expect, it } from 'vitest';
import type { AgentProfile } from '../../../../../contracts/orchestration-v2';
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

  it('keeps recursive and repeated saved spawn references available for explicit user choice', () => {
    const other = { ...profile, id: 'profile-b', name: 'Worker' };
    expect(spawnProfileOptions([profile, other], profile.id)).toEqual([profile, other]);
  });
});
