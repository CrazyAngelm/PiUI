import type { ProjectSummary } from '../../host-api/types';
import type { WorkspaceSession, WorkspaceSummary } from '../../../../../contracts/workspace-v15';

/** A project-folder dialog opened from the sidebar menu. */
export type ProjectDialogRequest = { readonly kind: 'rename' | 'remove'; readonly workspace: WorkspaceSummary };

export interface ProjectRemoval {
  /** Chats (not pipeline agents) that disappear from PiUI with the folder. */
  readonly chats: number;
  /** Agents still starting, running or stopping in the folder. */
  readonly running: number;
  /** Removal waits until nothing runs, so no turn or run step is cut off. */
  readonly blocked: boolean;
}

const ACTIVE: readonly WorkspaceSession['status'][] = ['starting', 'running', 'stopping'];

export function projectRemoval(workspaceId: string, sessions: readonly WorkspaceSession[]): ProjectRemoval {
  const own = sessions.filter((session) => session.workspaceId === workspaceId);
  const running = own.filter((session) => ACTIVE.includes(session.status)).length;
  return { chats: own.filter((session) => session.runId === undefined).length, running, blocked: running > 0 };
}

export function isPinned(projects: readonly ProjectSummary[], workspaceId: string): boolean {
  return projects.some((project) => project.id === workspaceId && project.pinned);
}
