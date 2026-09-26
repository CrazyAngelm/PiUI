import type { WorktreePreviewV1, WorktreeRequestV1 } from '../../../../../contracts/workspace-placement-v1';

/** A worktree the person confirmed in the new chat composer. */
export interface ConfirmedWorktree {
  workspaceId: string;
  branch: string;
  folder: string;
  path: string;
  expectedBase: string;
  shortBase: string;
}

/** "Continue in another harness": the source chat and the draft it replaced. */
export interface PendingHandoff {
  sourceSessionId: string;
  sourceTitle: string;
  sourceHarness: string;
  workspaceId: string;
  /** The source runs in a worktree; the new chat can continue there. */
  worktreeBranch?: string;
  shareWorktree: boolean;
  /** The new-chat draft before the handoff text replaced it. */
  stashedDraft: string;
}

/** What `createChat` sends to `workspace_placement_v1`, if anything. */
export interface PlacementRequest {
  worktree?: WorktreeRequestV1;
  continuedFrom?: string;
}

export function confirmedWorktree(preview: WorktreePreviewV1): ConfirmedWorktree {
  return {
    workspaceId: preview.workspaceId,
    branch: preview.branch,
    folder: preview.folder,
    path: preview.path,
    expectedBase: preview.base.commit,
    shortBase: preview.base.short,
  };
}

/**
 * Choices for the next chat started from the new-chat composer: a confirmed
 * worktree and a pending handoff. `epoch` changes when the composer must
 * remount with a new draft.
 */
export class NewChatPlacement {
  worktree = $state.raw<ConfirmedWorktree | undefined>();
  handoff = $state.raw<PendingHandoff | undefined>();
  epoch = $state(0);

  /** The placement for a chat in `workspaceId`; other projects get none. */
  requestFor(workspaceId: string): PlacementRequest | undefined {
    const handoff = this.handoff?.workspaceId === workspaceId ? this.handoff : undefined;
    const worktree = this.worktree?.workspaceId === workspaceId ? this.worktree : undefined;
    const request: PlacementRequest = {};
    if (handoff !== undefined) request.continuedFrom = handoff.sourceSessionId;
    if (worktree !== undefined) {
      request.worktree = { type: 'new', branch: worktree.branch, folder: worktree.folder, expectedBase: worktree.expectedBase };
    } else if (handoff?.shareWorktree && handoff.worktreeBranch !== undefined) {
      request.worktree = { type: 'shared', sessionId: handoff.sourceSessionId };
    }
    return request.worktree === undefined && request.continuedFrom === undefined ? undefined : request;
  }

  chooseWorktree(worktree: ConfirmedWorktree | undefined): void {
    this.worktree = worktree;
  }

  startHandoff(handoff: PendingHandoff): void {
    this.handoff = handoff;
    this.worktree = undefined;
    this.epoch += 1;
  }

  setShareWorktree(share: boolean): void {
    if (this.handoff !== undefined) this.handoff = { ...this.handoff, shareWorktree: share };
  }

  /** Ends a handoff; returns the draft it replaced when cancelled. */
  endHandoff(): string | undefined {
    const stashed = this.handoff?.stashedDraft;
    this.handoff = undefined;
    this.epoch += 1;
    return stashed;
  }

  /** Called after a chat started with this placement. */
  started(workspaceId: string): void {
    if (this.worktree?.workspaceId === workspaceId) this.worktree = undefined;
    if (this.handoff?.workspaceId === workspaceId) this.handoff = undefined;
  }
}

export const newChatPlacement = new NewChatPlacement();
