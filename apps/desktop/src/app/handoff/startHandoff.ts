import type { SessionSnapshot } from '../../../../../contracts/workspace-v15';
import { harnessMeta } from '../harnessMeta';
import { reviewedPaths } from '../review/reviewStore.svelte';
import { newChatPlacement } from '../worktrees/newChatPlacement.svelte';
import { placements } from '../worktrees/placements.svelte';
import type { WorkspaceStore } from '../workspaceStore.svelte';
import { buildHandoffDraft, HANDOFF_COPY, type HandoffCopy } from './handoff';

const NEW_CHAT_DRAFT = 'new-chat';

/**
 * "Continue in another harness…": opens the new chat composer for the same
 * project with an editable draft built from what the chat shows. Nothing is
 * sent and the source chat is not changed; the new chat records the link.
 */
export function startHandoff(store: WorkspaceStore, snapshot: SessionSnapshot, translate: (value: string) => string): void {
  const session = snapshot.session;
  const worktree = placements.get(session.id)?.worktree;
  const copy = Object.fromEntries(
    Object.entries(HANDOFF_COPY).map(([key, value]) => [key, translate(value)]),
  ) as unknown as HandoffCopy;
  const draft = buildHandoffDraft(
    {
      title: session.title,
      harnessLabel: harnessMeta(session.harness).label,
      blocks: snapshot.blocks,
      changedFiles: reviewedPaths(session.id),
      ...(worktree?.state === 'ready' ? { branch: worktree.branch } : {}),
    },
    copy,
  );
  const stashedDraft = newChatPlacement.handoff?.stashedDraft ?? store.draftFor(NEW_CHAT_DRAFT);
  store.updateDraft(NEW_CHAT_DRAFT, draft);
  newChatPlacement.startHandoff({
    sourceSessionId: session.id,
    sourceTitle: session.title,
    sourceHarness: harnessMeta(session.harness).label,
    workspaceId: session.workspaceId,
    ...(worktree?.state === 'ready' ? { worktreeBranch: worktree.branch } : {}),
    shareWorktree: worktree?.state === 'ready',
    stashedDraft,
  });
  store.goHome(session.workspaceId);
}

/** Cancels a pending handoff and brings back the draft it replaced. */
export function cancelHandoff(store: WorkspaceStore): void {
  const stashed = newChatPlacement.handoff?.stashedDraft;
  if (stashed !== undefined) store.updateDraft(NEW_CHAT_DRAFT, stashed);
  newChatPlacement.endHandoff();
}
