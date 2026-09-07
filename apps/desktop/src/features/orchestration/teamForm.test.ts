import { describe, expect, it } from 'vitest';
import type { AgentProfile, TeamDefinition } from '../../../../../contracts/orchestration-v5';
import { cloneTeamDefinition, createEmptyTeamDefinition, validateTeamDefinition } from './teamForm';

const profiles: readonly AgentProfile[] = [
  { id: 'planner', name: 'Planner', harness: 'pi', model: 'model', permissionMode: 'native', instructions: '', toolPolicy: { rules: [] }, allowedSpawnProfileIds: ['worker'] },
  { id: 'worker', name: 'Worker', harness: 'codex', model: 'model', permissionMode: 'read-only', instructions: '', toolPolicy: { rules: [] }, allowedSpawnProfileIds: [] },
];

const validTeam: TeamDefinition = {
  id: 'team-1', name: 'Delivery', orchestratorMemberId: 'plan',
  members: [{ id: 'plan', profileId: 'planner' }, { id: 'work', profileId: 'worker' }],
  sendEdges: [{ fromMemberId: 'plan', toMemberId: 'work' }],
  observeEdges: [{ fromMemberId: 'work', toMemberId: 'plan' }],
};

describe('team form helpers', () => {
  it('accepts a complete team with separate directed messaging and observation edges', () => {
    expect(validateTeamDefinition(validTeam, profiles)).toEqual([]);
  });

  it('creates an empty definition without implied members or permissions', () => {
    expect(createEmptyTeamDefinition('team-new')).toEqual({ id: 'team-new', name: '', members: [], sendEdges: [], observeEdges: [], orchestratorMemberId: '' });
  });

  it('reports missing profile references against the available profile catalog', () => {
    const team = { ...validTeam, members: [{ id: 'plan', profileId: 'missing' }] };
    expect(validateTeamDefinition(team, profiles).map((issue) => issue.code)).toContain('unknown-profile-reference');
  });

  it('reports duplicate member slots and an orchestrator that no longer identifies a member', () => {
    const team = { ...validTeam, members: [{ id: 'plan', profileId: 'planner' }, { id: 'plan', profileId: 'worker' }], orchestratorMemberId: 'missing' };
    const codes = validateTeamDefinition(team, profiles).map((issue) => issue.code);
    expect(codes).toContain('duplicate-member-id');
    expect(codes).toContain('unknown-orchestrator');
  });

  it('rejects dangling and duplicate directed edges without treating reverse edges as duplicates', () => {
    const team = {
      ...validTeam,
      sendEdges: [
        { fromMemberId: 'plan', toMemberId: 'work' },
        { fromMemberId: 'plan', toMemberId: 'work' },
        { fromMemberId: 'work', toMemberId: 'plan' },
        { fromMemberId: 'missing', toMemberId: 'plan' },
      ],
    };
    const codes = validateTeamDefinition(team, profiles).map((issue) => issue.code);
    expect(codes).toContain('duplicate-send-edge');
    expect(codes).toContain('unknown-edge-member');
    expect(codes.filter((code) => code === 'duplicate-send-edge')).toHaveLength(1);
  });

  it('returns detached draft data so failed saves can retain user input', () => {
    const draft = cloneTeamDefinition(validTeam);
    (draft.members as { id: string; profileId: string }[])[0].profileId = 'worker';
    expect(validTeam.members[0].profileId).toBe('planner');
  });
});
