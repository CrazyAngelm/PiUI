<script lang="ts">
  import { t } from '../../features/locale/language';
  import type { ManagedWorktreeV1, WorktreeChangeV1 } from '../../../../../contracts/workspace-placement-v1';
  import { Button, Checkbox, Dialog, toasts } from '../../lib/ui';
  import { WORKTREE_CHANGE_LABELS } from './managedWorktrees';
  import { placementRequest } from './placements.svelte';

  /**
   * Removes a worktree no chat uses any more (workspace placement v1.1). The
   * first step names the folder; a worktree with uncommitted changes lists
   * them and needs an explicit acknowledgement of exactly those changes. The
   * host refuses when they differ from the confirmed ones. The branch stays.
   */
  interface Props {
    worktree: ManagedWorktreeV1;
    onClose: () => void;
    onRemoved: () => void;
  }
  let { worktree, onClose, onRemoved }: Props = $props();

  let stage = $state<'confirm' | 'dirty'>('confirm');
  let busy = $state(false);
  let error = $state('');
  let changes = $state(0);
  let fingerprint = $state('');
  let files = $state.raw<WorktreeChangeV1[]>([]);
  let truncated = $state(false);
  let acknowledged = $state(false);

  function message(cause: unknown): string {
    return cause instanceof Error ? cause.message : 'The operation could not be completed.';
  }

  async function remove(discard: boolean): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    try {
      const result = await placementRequest({
        type: 'removeOrphanWorktree',
        worktreeId: worktree.id,
        discardChanges: discard,
        ...(discard ? { expectedChanges: fingerprint } : {}),
      });
      if (result.type === 'worktreeDirty') {
        stage = 'dirty';
        changes = result.changes;
        fingerprint = result.fingerprint;
        files = result.files;
        truncated = result.truncated;
        acknowledged = false;
      } else if (result.type === 'worktreeRemoved') {
        toasts.success($t('Worktree removed'), $t('The branch {0} stays with its commits.', [worktree.branch]));
        onRemoved();
      }
    } catch (cause) {
      error = message(cause);
      if ((cause as { code?: unknown }).code === 'STALE') {
        // The changes are not the ones confirmed: show the current ones.
        busy = false;
        await remove(false);
        error = message(cause);
      }
    } finally {
      busy = false;
    }
  }
</script>

<Dialog
  open={true}
  title={stage === 'dirty' ? $t('Remove the worktree and lose its changes?') : $t('Remove this worktree?')}
  size={stage === 'dirty' ? 'lg' : 'md'}
  onOpenChange={(open) => {
    if (!open && !busy) onClose();
  }}
>
  <div class="body">
    {#if stage === 'confirm'}
      {#if worktree.state === 'missing'}
        <p>{$t('The worktree folder is already gone. PiUI forgets it:')}</p>
      {:else}
        <p>{$t('PiUI deletes the worktree folder:')}</p>
      {/if}
      <p class="mono">{worktree.path}</p>
      <p>{$t('The branch {0} stays with its commits. No chat works in this worktree any more.', [worktree.branch])}</p>
    {:else}
      <p><strong>{$t('This worktree has {0} uncommitted changes.', [changes])}</strong> {$t('Removing it deletes them for good. They do not go to the Trash. Commit them on the branch first if you want to keep them.')}</p>
      {#if files.length}
        <ul class="files" aria-label={$t('Changes that will be lost')}>
          {#each files as file (`${file.area}:${file.path}`)}
            <li><span class="mono">{file.path}</span> <span class="muted">{$t(WORKTREE_CHANGE_LABELS[file.area])}</span></li>
          {/each}
        </ul>
      {/if}
      {#if truncated || changes > files.length}
        <p class="muted">{$t('{0} more changes are not listed.', [Math.max(0, changes - files.length)])}</p>
      {/if}
      <Checkbox bind:checked={acknowledged} label={$t('I understand that these {0} changes will be lost', [changes])} />
    {/if}
    {#if error}<p class="error" role="alert">{$t(error)}</p>{/if}
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={onClose} disabled={busy}>{$t('Cancel')}</Button>
    {#if stage === 'confirm'}
      <Button variant="danger" onclick={() => void remove(false)} loading={busy}>{$t('Remove worktree')}</Button>
    {:else}
      <Button variant="danger" onclick={() => void remove(true)} loading={busy} disabled={!acknowledged}>{$t('Remove and lose changes')}</Button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .body {
    display: grid;
    gap: var(--piui-space-3);
  }
  p {
    margin: 0;
    color: var(--piui-text-muted);
    line-height: var(--piui-leading-normal);
  }
  strong {
    color: var(--piui-text);
  }
  .mono {
    color: var(--piui-text);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-sm);
    word-break: break-all;
  }
  .files {
    display: grid;
    gap: 2px;
    max-height: 220px;
    margin: 0;
    padding: var(--piui-space-2) var(--piui-space-3);
    overflow-y: auto;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-sm);
    list-style: none;
  }
  .muted {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .error {
    color: var(--piui-danger);
  }
</style>
