import type { ManagedWorktreeV1, WorktreeChangeV1 } from '../../../../../contracts/workspace-placement-v1';

/** English labels (locale keys) of the change areas an orphan's removal lists. */
export const WORKTREE_CHANGE_LABELS: Readonly<Record<WorktreeChangeV1['area'], string>> = {
  staged: 'Staged',
  unstaged: 'Changes',
  untracked: 'New files',
  conflict: 'Conflict',
};

export interface WorktreeChat {
  id: string;
  title: string;
}

/** One row of Settings → Worktrees. */
export interface WorktreeRow {
  worktree: ManagedWorktreeV1;
  /** The project's name, or empty when PiUI no longer lists the project. */
  projectName: string;
  /** Chats that run in it and that the sidebar can open. */
  chats: WorktreeChat[];
  /** No chat runs in it any more: only here can it be removed. */
  orphan: boolean;
}

/**
 * Rows for the managed worktrees: orphans (their chats were deleted) first,
 * then by project and branch. A chat the catalog does not list is not
 * offered for opening; the worktree still counts as used by it, as the host
 * reported.
 */
export function worktreeRows(
  worktrees: readonly ManagedWorktreeV1[],
  chats: readonly WorktreeChat[],
  projects: readonly { id: string; name: string }[],
): WorktreeRow[] {
  const titles = new Map(chats.map((chat) => [chat.id, chat.title]));
  const names = new Map(projects.map((project) => [project.id, project.name]));
  return worktrees
    .map((worktree) => ({
      worktree,
      projectName: names.get(worktree.workspaceId) ?? '',
      chats: worktree.sessions.flatMap((id) => {
        const title = titles.get(id);
        return title === undefined ? [] : [{ id, title }];
      }),
      orphan: worktree.sessions.length === 0,
    }))
    .sort(
      (left, right) =>
        Number(right.orphan) - Number(left.orphan)
        || left.projectName.localeCompare(right.projectName)
        || left.worktree.branch.localeCompare(right.worktree.branch),
    );
}
