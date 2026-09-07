import type { AgentProfile, DirectedEdge, OrchestrationId, TeamDefinition, TeamMember } from '../../../../../contracts/orchestration-v4';

export interface TeamFormIssue {
  readonly code:
    | 'missing-team-id'
    | 'missing-team-name'
    | 'missing-member-id'
    | 'duplicate-member-id'
    | 'missing-profile-reference'
    | 'unknown-profile-reference'
    | 'missing-orchestrator'
    | 'unknown-orchestrator'
    | 'missing-edge-member'
    | 'unknown-edge-member'
    | 'duplicate-send-edge'
    | 'duplicate-observe-edge';
  readonly path: string;
  readonly message: string;
}

/** Make a writable, detached editor value from an immutable contract value. */
export function cloneTeamDefinition(team: TeamDefinition): TeamDefinition {
  return {
    ...team,
    members: team.members.map((member) => ({ ...member })),
    sendEdges: team.sendEdges.map((edge) => ({ ...edge })),
    observeEdges: team.observeEdges.map((edge) => ({ ...edge })),
  };
}

export function createEmptyTeamDefinition(id: OrchestrationId): TeamDefinition {
  return {
    id,
    name: '',
    members: [],
    sendEdges: [],
    observeEdges: [],
    orchestratorMemberId: '',
  };
}

export function edgeKey(edge: DirectedEdge): string {
  return `${edge.fromMemberId}\u0000${edge.toMemberId}`;
}

export function memberById(members: readonly TeamMember[], memberId: OrchestrationId): TeamMember | undefined {
  return members.find((member) => member.id === memberId);
}

export function profileById(profiles: readonly AgentProfile[], profileId: OrchestrationId): AgentProfile | undefined {
  return profiles.find((profile) => profile.id === profileId);
}

/**
 * Validate the references that TeamDefinition itself carries. Profile checking
 * is optional so callers with an incomplete catalog do not silently rewrite a
 * stored definition; the editor passes its current catalog to make missing
 * references visible before saving.
 */
export function validateTeamDefinition(
  team: TeamDefinition,
  profiles?: readonly AgentProfile[],
): readonly TeamFormIssue[] {
  const issues: TeamFormIssue[] = [];
  if (team.id.trim() === '') issues.push({ code: 'missing-team-id', path: 'id', message: 'Team ID is required.' });
  if (team.name.trim() === '') issues.push({ code: 'missing-team-name', path: 'name', message: 'Team name is required.' });

  const memberIds = new Set<string>();
  for (const [index, member] of team.members.entries()) {
    const path = `members[${index}]`;
    if (member.id.trim() === '') issues.push({ code: 'missing-member-id', path: `${path}.id`, message: 'Member slot ID is required.' });
    else if (memberIds.has(member.id)) issues.push({ code: 'duplicate-member-id', path: `${path}.id`, message: `Member slot ID “${member.id}” is duplicated.` });
    else memberIds.add(member.id);

    if (member.profileId.trim() === '') {
      issues.push({ code: 'missing-profile-reference', path: `${path}.profileId`, message: 'Choose a profile for this member slot.' });
    } else if (profiles !== undefined && profileById(profiles, member.profileId) === undefined) {
      issues.push({ code: 'unknown-profile-reference', path: `${path}.profileId`, message: `Profile “${member.profileId}” is not available.` });
    }
  }

  if (team.orchestratorMemberId.trim() === '') {
    issues.push({ code: 'missing-orchestrator', path: 'orchestratorMemberId', message: 'Choose the orchestrator member.' });
  } else if (!memberIds.has(team.orchestratorMemberId)) {
    issues.push({ code: 'unknown-orchestrator', path: 'orchestratorMemberId', message: 'The orchestrator must be a team member.' });
  }

  validateEdges(team.sendEdges, 'sendEdges', 'duplicate-send-edge', memberIds, issues);
  validateEdges(team.observeEdges, 'observeEdges', 'duplicate-observe-edge', memberIds, issues);
  return issues;
}

function validateEdges(
  edges: readonly DirectedEdge[],
  path: 'sendEdges' | 'observeEdges',
  duplicateCode: 'duplicate-send-edge' | 'duplicate-observe-edge',
  memberIds: ReadonlySet<string>,
  issues: TeamFormIssue[],
): void {
  const keys = new Set<string>();
  for (const [index, edge] of edges.entries()) {
    const edgePath = `${path}[${index}]`;
    if (edge.fromMemberId.trim() === '' || edge.toMemberId.trim() === '') {
      issues.push({ code: 'missing-edge-member', path: edgePath, message: 'Choose both the source and destination members.' });
    } else if (!memberIds.has(edge.fromMemberId) || !memberIds.has(edge.toMemberId)) {
      issues.push({ code: 'unknown-edge-member', path: edgePath, message: 'Each relationship must reference current team members.' });
    }
    const key = edgeKey(edge);
    if (keys.has(key)) issues.push({ code: duplicateCode, path: edgePath, message: 'This directed relationship is duplicated.' });
    else keys.add(key);
  }
}
