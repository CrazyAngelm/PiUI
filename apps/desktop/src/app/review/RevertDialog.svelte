<script lang="ts">
  import { t } from '../../features/locale/language';
  import type { ReviewDiffV1 } from '../../../../../contracts/workspace-review-v1';
  import { Button, Dialog } from '../../lib/ui';
  import DiffView from '../chat/transcript/DiffView.svelte';
  import { formatSize, hunkText } from './review';

  interface Props {
    diff: ReviewDiffV1;
    /** The diff text as shown (with split hunks as their parts). */
    text?: string | undefined;
    /** The index of a hunk in the shown text, or undefined for the whole file. */
    hunk: number | undefined;
    busy: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  }
  let { diff, text: shownText = undefined, hunk, busy, onConfirm, onCancel }: Props = $props();

  const untracked = $derived(diff.area === 'untracked');
  const text = $derived(
    diff.content.kind === 'text' ? (hunk === undefined ? diff.content.text : hunkText(shownText ?? diff.content.text, hunk)) : '',
  );
  const title = $derived(
    untracked ? $t('Move {0} to the Trash?', [diff.path]) : hunk === undefined ? $t('Revert all changes in {0}?', [diff.path]) : $t('Revert this change in {0}?', [diff.path]),
  );
</script>

<Dialog
  open={true}
  {title}
  size="lg"
  onOpenChange={(open) => {
    if (!open && !busy) onCancel();
  }}
>
  <div class="body">
    {#if untracked}
      <p>{$t('The file leaves the project folder and goes to the system Trash, where you can restore it. It was never committed.')}</p>
    {:else}
      <p><strong>{$t('These changes will be lost.')}</strong> {$t('The file goes back to its staged version. Lines marked − come back; lines marked + are removed.')}</p>
    {/if}
    {#if diff.content.kind === 'text'}
      <DiffView {text} collapseAfter={Number.MAX_SAFE_INTEGER} />
    {:else if diff.content.kind === 'binary'}
      <p class="muted">
        {untracked
          ? $t('Binary file, {0}.', [formatSize(diff.content.size) || '—'])
          : $t('Binary file: the working copy ({0}) is replaced by the staged version.', [formatSize(diff.content.size) || '—'])}
      </p>
    {:else}
      <p class="muted">{$t('This file is too large to show.')}</p>
    {/if}
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={onCancel} disabled={busy}>{$t('Cancel')}</Button>
    <Button variant="danger" onclick={onConfirm} loading={busy}>
      {untracked ? $t('Move to Trash') : $t('Revert changes')}
    </Button>
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
  .muted {
    font-size: var(--piui-text-sm);
  }
</style>
