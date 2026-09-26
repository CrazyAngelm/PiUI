/**
 * PiUI workspace review protocol v1 (`workspace_review_v1`): the git changes
 * of the folder a chat works in — its trusted project folder or its
 * PiUI-managed worktree (see `workspace-placement-v1.ts`). Independently
 * versioned; workspace v15 is unchanged.
 *
 * Paths are repository-relative with `/` separators exactly as git reports
 * them, limited to the project folder's part of the repository. A diff
 * carries the SHA-256 `fingerprint` of the exact change it shows; every
 * action repeats it and the host refuses with `STALE` when the change is no
 * longer the reviewed one. `hunk` is the index of an `@@` hunk in the shown
 * text. Staging, unstaging and reverting replay the reviewed change (or that
 * hunk) through `git apply`; reverting an untracked file moves it to the
 * system trash. Reads work in safe mode (`readOnly: true`); every action is
 * refused there with `SAFE_MODE`. Git runs without repository hooks.
 */
export const WORKSPACE_REVIEW_PROTOCOL = 1 as const;

/** `staged`: index vs HEAD; `unstaged`: work tree vs index; `untracked`: new files. */
export type ReviewArea = 'staged' | 'unstaged' | 'untracked';

export type ReviewChange =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'type-changed'
  /** `git add -N`: unstage it before it can go to the trash. */
  | 'intent-to-add'
  /** Unmerged; no actions. */
  | 'conflict'
  /** Submodule pointer; no actions. */
  | 'submodule';

export interface ReviewFileV1 {
  path: string;
  area: ReviewArea;
  change: ReviewChange;
  /** Line counts; absent for untracked and binary files. */
  added?: number;
  removed?: number;
  binary?: true;
}

export type ReviewRepositoryV1 =
  | {
    state: 'ready';
    /** Checked-out branch; absent when HEAD is detached. */
    branch?: string;
    /** First 12 characters of the HEAD commit; absent before the first commit. */
    head?: string;
    /** The chat works in a PiUI-managed worktree. */
    worktree: boolean;
    /** Name of the chat's folder. */
    folder: string;
  }
  /** Not inside a git work tree (or a personal chat). */
  | { state: 'not-repository' };

export interface ReviewStatusV1 {
  protocol: 1;
  type: 'status';
  sessionId: string;
  repository: ReviewRepositoryV1;
  /** One entry per path and area; a path can be both staged and unstaged. */
  files: ReviewFileV1[];
  /** More than 2000 entries; the rest are not listed. */
  truncated: boolean;
  /** Paths PiUI cannot show (not UTF-8 or with control characters). */
  hidden: number;
  /** Safe mode: every action is refused. */
  readOnly: boolean;
}

export type ReviewContentV1 =
  /** Unified diff text (without `index` lines); untracked files show as new files. */
  | { kind: 'text'; text: string; hunks: number; hunkActions: boolean }
  | { kind: 'binary'; size?: number }
  /** Longer than PiUI shows (512 KiB of diff, 256 KiB of a new file). */
  | { kind: 'too-large'; size?: number }
  | { kind: 'symlink' }
  | { kind: 'submodule' }
  | { kind: 'conflict' };

export interface ReviewActionsV1 {
  stage: boolean;
  unstage: boolean;
  /** Discard the unstaged change, or move an untracked file to the trash. */
  revert: boolean;
}

export interface ReviewDiffV1 {
  protocol: 1;
  type: 'diff';
  sessionId: string;
  path: string;
  area: ReviewArea;
  /** Lowercase hex SHA-256 of the exact reviewed change. */
  fingerprint: string;
  content: ReviewContentV1;
  actions: ReviewActionsV1;
}

export type ReviewRequestV1 =
  | { type: 'status'; sessionId: string }
  | { type: 'diff'; sessionId: string; path: string; area: ReviewArea }
  | { type: 'stage'; sessionId: string; path: string; area: 'unstaged' | 'untracked'; fingerprint: string; hunk?: number }
  | { type: 'unstage'; sessionId: string; path: string; fingerprint: string; hunk?: number }
  | { type: 'revert'; sessionId: string; path: string; area: 'unstaged' | 'untracked'; fingerprint: string; hunk?: number };

/** `status` and `diff` answer with their type; every action answers with a fresh status. */
export type ReviewResultV1 = ReviewStatusV1 | ReviewDiffV1;

export type ReviewErrorCode =
  | 'SAFE_MODE'
  | 'NOT_TRUSTED'
  | 'NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'PROJECT_UNAVAILABLE'
  | 'CONFLICT'
  | 'NOT_A_REPOSITORY'
  | 'STALE'
  | 'NOT_SUPPORTED'
  | 'TOO_LARGE'
  | 'GIT_UNAVAILABLE'
  | 'GIT_REFUSED'
  | 'GIT_BUSY'
  | 'GIT_FAILED'
  | 'TRASH_UNAVAILABLE'
  | 'TRASH_FAILED'
  | 'WORKTREE_REMOVED'
  | 'WORKTREE_UNAVAILABLE'
  | 'IO_ERROR';

export interface ReviewErrorV1 { code: ReviewErrorCode; message: string; recoverable: boolean }
