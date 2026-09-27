/**
 * PiUI workspace placement protocol v1 (`workspace_placement_v1`): where a
 * chat runs and where it came from. Independently versioned; workspace v15
 * commands, events and the session registry format are unchanged.
 *
 * - A worktree chat runs in a PiUI-managed git worktree of its project,
 *   `<app data>/worktrees/<project>-<id>/<folder>`, on a new branch created
 *   from the project's current commit. `previewWorktree` shows the exact
 *   branch, folder and commit; `createChat` with `worktree.type: 'new'`
 *   must repeat them and is refused with `STALE` when any of them changed.
 *   Nothing is copied from the project folder. The chat inherits the
 *   project's trust while git confirms the worktree shares the project's
 *   common git directory.
 * - `worktree.type: 'shared'` runs a new chat in the worktree of another
 *   chat of the same project (continuing work there).
 * - `continuedFrom` links a chat to the chat it continues ("Continue in
 *   another harness"). No history is converted; the source is unchanged.
 * - `removeWorktree` answers `dirty` (nothing removed) while the worktree has
 *   changes or untracked files; repeating it with `discardChanges: true` and
 *   that `fingerprint` removes it. The branch is never deleted. The chat
 *   stays readable and cannot start again (`WORKTREE_REMOVED`).
 * - `adopted` marks a Pi session adopted from the terminal
 *   (`workspace-adopt-v1.ts`).
 *
 * - `worktrees` (additive, v1.1) lists every PiUI-managed worktree that was
 *   not removed, with the chats still in PiUI that run in it. One without
 *   chats is an orphan (its chats were deleted): `removeOrphanWorktree`
 *   removes it like `removeWorktree`, answering `worktreeDirty` with the
 *   changes it would lose (at most 200 listed) until they are confirmed by
 *   `fingerprint`. A worktree a chat still uses is refused (`CONFLICT`). A
 *   missing folder is only forgotten. The branch is never deleted and no
 *   empty folder is left behind. An older host refuses both commands.
 *
 * `list` and `worktrees` work in safe mode and need no trust; the rest is
 * refused in safe mode (`SAFE_MODE`). Paths are home-relative display text
 * (`~/…`).
 */
import type { HarnessKind, PermissionMode, SessionSnapshot, WorkspaceModel } from './workspace-v15';

export const WORKSPACE_PLACEMENT_PROTOCOL = 1 as const;

export type WorktreeStateV1 = 'ready' | 'missing' | 'removed';

export interface ChatWorktreeV1 {
  branch: string;
  /** Home-relative display path of the worktree folder. */
  path: string;
  state: WorktreeStateV1;
  /** First 12 characters of the commit the worktree started from. */
  base: string;
}

export interface ChatPlacementV1 {
  sessionId: string;
  worktree?: ChatWorktreeV1;
  continuedFrom?: string;
  adopted?: true;
}

/** A PiUI-managed worktree (v1.1). */
export interface ManagedWorktreeV1 {
  /** Opaque id; repeat it in `removeOrphanWorktree`. */
  id: string;
  workspaceId: string;
  branch: string;
  path: string;
  state: Exclude<WorktreeStateV1, 'removed'>;
  base: string;
  /** Chats that run in it; empty for an orphan. */
  sessions: string[];
}

/** One change removing an orphan worktree would lose (v1.1). */
export interface WorktreeChangeV1 {
  path: string;
  area: 'staged' | 'unstaged' | 'untracked' | 'conflict';
}

export interface WorktreePreviewV1 {
  workspaceId: string;
  branch: string;
  /** Folder name inside PiUI's worktree area; repeat it in `createChat`. */
  folder: string;
  path: string;
  base: {
    /** Full commit id; repeat it as `expectedBase`. */
    commit: string;
    short: string;
    /** The project's checked-out branch, when it has one. */
    branch?: string;
  };
  /** The project folder has uncommitted changes the worktree will not include. */
  projectChanges: boolean;
}

export type WorktreeRequestV1 =
  | { type: 'new'; branch: string; folder: string; expectedBase: string }
  | { type: 'shared'; sessionId: string };

export type WorkspacePlacementCommandV1 =
  | { type: 'list' }
  /** Without `branch` the host suggests `piui/chat-xxxxxx`. */
  | { type: 'previewWorktree'; workspaceId: string; branch?: string }
  | {
    type: 'createChat';
    workspaceId: string;
    harness: HarnessKind;
    permissionMode: PermissionMode;
    title?: string;
    model?: WorkspaceModel;
    /** At least one of `worktree` and `continuedFrom`. */
    worktree?: WorktreeRequestV1;
    continuedFrom?: string;
  }
  | { type: 'removeWorktree'; sessionId: string; discardChanges: boolean; expectedChanges?: string }
  | { type: 'worktrees' }
  | { type: 'removeOrphanWorktree'; worktreeId: string; discardChanges: boolean; expectedChanges?: string };

export type WorkspacePlacementResultV1 =
  | { protocol: 1; type: 'placements'; placements: ChatPlacementV1[] }
  | { protocol: 1; type: 'preview'; preview: WorktreePreviewV1 }
  | { protocol: 1; type: 'created'; snapshot: SessionSnapshot; placement: ChatPlacementV1 }
  | { protocol: 1; type: 'removed'; sessionId: string; placement: ChatPlacementV1 }
  /** Not removed: `changes` uncommitted changes and untracked files. */
  | { protocol: 1; type: 'dirty'; sessionId: string; changes: number; fingerprint: string }
  | { protocol: 1; type: 'worktrees'; worktrees: ManagedWorktreeV1[] }
  /** Not removed: the orphan has `changes` changes; `files` lists them. */
  | {
    protocol: 1;
    type: 'worktreeDirty';
    worktreeId: string;
    changes: number;
    fingerprint: string;
    files: WorktreeChangeV1[];
    truncated: boolean;
  }
  | { protocol: 1; type: 'worktreeRemoved'; worktreeId: string };

export type PlacementErrorCode =
  | 'SAFE_MODE'
  | 'NOT_TRUSTED'
  | 'NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'NOT_SUPPORTED'
  | 'NOT_A_REPOSITORY'
  | 'NO_COMMITS'
  | 'INVALID_BRANCH'
  | 'BRANCH_EXISTS'
  | 'STALE'
  | 'CONFLICT'
  | 'GIT_UNAVAILABLE'
  | 'GIT_REFUSED'
  | 'GIT_BUSY'
  | 'GIT_FAILED'
  | 'WORKTREE_REMOVED'
  | 'WORKTREE_UNAVAILABLE'
  | 'IO_ERROR'
  /** Any workspace v15 start refusal (`RUNTIME_FAILED`, `SIGN_IN_REQUIRED`, …). */
  | (string & {});

export interface PlacementErrorV1 { code: PlacementErrorCode; message: string; recoverable: boolean }
