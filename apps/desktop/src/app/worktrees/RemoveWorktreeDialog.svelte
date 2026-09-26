<script lang="ts">
  import { t } from '../../features/locale/language';
  import type { ReviewFileV1 } from '../../../../../contracts/workspace-review-v1';
  import { Button, Checkbox, Dialog, toasts } from '../../lib/ui';
  import { AREA_LABELS } from '../review/review';
  import { placementRequest, placements } from './placements.svelte';

  interface Props {
    sessionId: string;
    branch: string;
    path: string;
    onClose: () => void;
  }
  let { sessionId, branch, path, onClose }: Props = $props();

  let stage = $state<'confirm' | 'dirty'>('confirm');
  let busy = $state(false);
  let error = $state('');
  let changes = $state(0);
  let fingerprint = $state('');
  let files = $state.raw<ReviewFileV1[]>([]);
  let acknowledged = $state(false);

  function message(cause: unknown): string {
    return cause instanceof Error ? cause.message : 'The operation could not be completed.';
  }

  async function listChanges(): Promise<void> {
    try {
      const { reviewHost } = await import('../../host-api/reviewClient');
      const status = await reviewHost.request({ type: 'status', sessionId });
      if (status.type === 'status') files = status.files;
    } catch {
      files = [];
    }
  }

  async function remove(discard: boolean): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    try {
      const result = await placementRequest({
        type: 'removeWorktree',
        sessionId,
        discardChanges: discard,
        ...(discard ? { expectedChanges: fingerprint } : {}),
      });
      if (result.type === 'dirty') {
        stage = 'dirty';
        changes = result.changes;
        fingerprint = result.fingerprint;
        acknowledged = false;
        await listChanges();
      } else if (result.type === 'removed') {
        placements.put(result.placement);
        void placements.refresh();
        toasts.success($t('Worktree removed'), $t('The branch {0} stays with its commits.', [branch]));
        onClose();
      }
    } catch (cause) {
      error = message(cause);
      if ((cause as { code?: unknown }).code === 'STALE') {
        // The changes are not the ones confirmed: show the current ones.
        stage = 'confirm';
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
      <p>{$t('PiUI deletes the worktree folder:')}</p>
      <p class="mono">{path}</p>
      <p>
        {$t('The branch {0} stays with its commits. Chats that work in this worktree stop; their history stays readable.', [branch])}
      </p>
    {:else}
      <p><strong>{$t('This worktree has {0} uncommitted changes.', [changes])}</strong> {$t('Removing it deletes them for good. They do not go to the Trash. Commit them on the branch first if you want to keep them.')}</p>
      {#if files.length}
        <ul class="files" aria-label={$t('Changes that will be lost')}>
          {#each files as file (`${file.area}:${file.path}`)}
            <li><span class="mono">{file.path}</span> <span class="muted">{$t(AREA_LABELS[file.area])}</span></li>
          {/each}
        </ul>
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
