import { CLAUDE_SIGN_IN_MESSAGE } from '../catalogFake';
import type { AgentProfile, LaunchCommandReference, PipelineDefinition, TeamDefinition } from '../labContracts';
import { labUuid } from '../labRandom';
import { emptyOrchestration } from '../labState';
import type { LabSeed } from './seedTypes';

/**
 * `?claude=signed-out` (any scenario): Claude Code is installed but the host's
 * last check found no Claude subscription login, as after a refused start. A
 * "Claude check" system (one Claude Code step) is saved in the first trusted
 * project so the run panel's sign-in failure can be seen; the new-chat
 * composer shows the sign-in status when Claude Code is picked.
 */
export function withSignedOutClaude(seed: LabSeed): LabSeed {
  const harnesses = seed.harnesses.map((summary) =>
    summary.kind === 'claude-code' && summary.status === 'available' ? { ...summary, reason: CLAUDE_SIGN_IN_MESSAGE } : summary);
  const project = seed.projects.find((candidate) => candidate.trustState === 'trusted' && !candidate.missing && !candidate.personal)
    ?? seed.projects.find((candidate) => candidate.trustState === 'trusted' && !candidate.missing);
  if (project === undefined) return { ...seed, harnesses };
  const id = (name: string): string => labUuid(`claude-signed-out:${name}`);
  const profile: AgentProfile = {
    id: id('profile'), name: 'Claude reviewer', harness: 'claude-code', modelProvider: 'anthropic', model: 'lab-sonnet',
    permissionMode: 'read-only', instructions: 'Review the change and list concrete risks.', toolPolicy: { rules: [] },
    allowedSpawnProfileIds: [],
  };
  const member = id('member');
  const team: TeamDefinition = {
    id: id('team'), name: 'Claude check', members: [{ id: member, profileId: profile.id }],
    sendEdges: [], observeEdges: [], orchestratorMemberId: member,
  };
  const pipeline: PipelineDefinition = {
    id: id('pipeline'), name: 'Claude check',
    steps: [{ id: member, name: 'Claude reviewer', assignedMemberId: member, dependencyStepIds: [], instructions: 'Review the latest change.' }],
  };
  const command: LaunchCommandReference = { id: id('command'), name: 'Claude check', teamId: team.id, pipelineId: pipeline.id };
  const existing = seed.orchestration.find((workspace) => workspace.workspaceId === project.id);
  const workspace = existing ?? emptyOrchestration(project.id);
  workspace.profiles.push({ revision: 0, value: profile });
  workspace.teams.push({ revision: 0, value: team });
  workspace.pipelines.push({ revision: 0, value: pipeline });
  workspace.launchCommands.push({ revision: 0, value: command });
  return { ...seed, harnesses, orchestration: existing ? seed.orchestration : [...seed.orchestration, workspace] };
}
