import type {
  AgentProfile,
  MessageStatus,
  OrchestrationRunV5,
  RunStatus,
  TaskRecord,
  TaskStatus,
  TeamMember,
} from '../../../../../contracts/orchestration-v5';

export interface StatusPresentation {
  readonly icon: string;
  readonly label: string;
  readonly tone: 'neutral' | 'active' | 'success' | 'danger' | 'warning';
}

export interface TaskDisplay {
  readonly task: TaskRecord | undefined;
  readonly stepId: string;
  readonly stepName: string;
  readonly member: TeamMember | undefined;
  readonly profile: AgentProfile | undefined;
  readonly status: StatusPresentation;
  /** PiUI workspace session id supplied by the coordinator, never a native id/path/handle. */
  readonly sessionId: string | undefined;
}

export function statusPresentation(status: RunStatus | TaskStatus | MessageStatus): StatusPresentation {
  switch (status) {
    case 'running': return { icon: '>', label: 'Running', tone: 'active' };
    case 'ready': return { icon: 'o', label: 'Ready', tone: 'neutral' };
    case 'succeeded': return { icon: 'OK', label: 'Succeeded', tone: 'success' };
    case 'failed': return { icon: '!', label: 'Failed', tone: 'danger' };
    case 'cancelled': return { icon: 'x', label: 'Cancelled', tone: 'neutral' };
    case 'uncertain': return { icon: '?', label: 'Needs reconciliation', tone: 'warning' };
    case 'accepted': return { icon: 'o', label: 'Accepted', tone: 'neutral' };
    case 'delivered': return { icon: 'OK', label: 'Delivered', tone: 'success' };
  }
}

export function memberById(run: OrchestrationRunV5, memberId: string): TeamMember | undefined {
  return run.definition.team.members.find((member) => member.id === memberId);
}

export function profileForMember(run: OrchestrationRunV5, member: TeamMember | undefined): AgentProfile | undefined {
  return member === undefined ? undefined : run.definition.profiles.find((profile) => profile.id === member.profileId);
}

/** Execution ids are explicitly coordinator-bound PiUI workspace-session ids. */
export function sessionIdForTask(task: TaskRecord | undefined): string | undefined {
  return task?.execution?.id;
}

export function taskDisplays(run: OrchestrationRunV5): readonly TaskDisplay[] {
  const tasks = new Map(run.tasks.map(task => [task.stepId, task]));
  const members = new Map(run.definition.team.members.map(member => [member.id, member]));
  const profiles = new Map(run.definition.profiles.map(profile => [profile.id, profile]));
  return run.definition.pipeline.steps.map((step) => {
    const task = tasks.get(step.id);
    const member = members.get(step.assignedMemberId);
    return {
      task,
      stepId: step.id,
      stepName: step.name || step.id,
      member,
      profile: member ? profiles.get(member.profileId) : undefined,
      status: task === undefined ? statusPresentation('uncertain') : statusPresentation(task.status),
      sessionId: sessionIdForTask(task),
    };
  });
}

export function memberLabel(run: OrchestrationRunV5, memberId: string): string {
  const member = memberById(run, memberId);
  const profile = profileForMember(run, member);
  return profile?.name || member?.id || `Unknown member (${memberId})`;
}
