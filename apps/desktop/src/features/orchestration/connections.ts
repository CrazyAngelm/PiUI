import type { DirectedEdge, TeamMember } from '../../../../../contracts/orchestration-v2';

export function connectionPreset(members: readonly TeamMember[], orchestrator: string, mode: 'orchestrator' | 'everyone'): readonly DirectedEdge[] {
  return members.flatMap(from => members.flatMap(to => from.id !== to.id && (mode === 'everyone' || from.id === orchestrator || to.id === orchestrator)
    ? [{ fromMemberId: from.id, toMemberId: to.id }] : []));
}

export function setConnection(edges: readonly DirectedEdge[], from: string, to: string, enabled: boolean): readonly DirectedEdge[] {
  const remaining = edges.filter(edge => edge.fromMemberId !== from || edge.toMemberId !== to);
  return enabled && from !== to ? [...remaining, { fromMemberId: from, toMemberId: to }] : remaining;
}
