<script lang="ts">
  import FileText from '@lucide/svelte/icons/file-text';
  import { t } from '../../../features/locale/language';
  import type { ComposerFileReference } from '../../../host-api/composerInputsClient';
  import { Button, Dialog } from '../../../lib/ui';

  interface Props {
    references: readonly ComposerFileReference[];
    onConfirm: () => void;
    onCancel: () => void;
  }
  let { references, onConfirm, onCancel }: Props = $props();
  let open = $state(true);
  $effect(() => {
    open = references.length > 0;
  });
</script>

<Dialog
  bind:open
  title={references.length === 1 ? $t('Reference this file by its path?') : $t('Reference {0} files by their paths?', [references.length])}
  description={$t('The agent reads referenced files with its own tools. PiUI does not upload, copy or attach them.')}
  closeLabel={$t('Cancel')}
  onOpenChange={(next) => {
    if (!next) onCancel();
  }}
>
  <ul class="references" aria-label={$t('File references')}>
    {#each references as item, index (`${index}:${item.reference}`)}
      <li>
        <FileText size={14} />
        <span class="references__name">{item.name}</span>
        <code class="references__text">{item.reference}</code>
        {#if !item.inProject}<small class="references__note">{$t('Outside the project folder')}</small>{/if}
      </li>
    {/each}
  </ul>
  {#snippet footer()}
    <Button variant="ghost" onclick={onCancel}>{$t('Cancel')}</Button>
    <Button variant="primary" onclick={onConfirm}>{$t('Insert references')}</Button>
  {/snippet}
</Dialog>

<style>
  .references {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .references li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    column-gap: 8px;
    row-gap: 2px;
    color: var(--piui-text-muted);
  }
  .references__name {
    overflow: hidden;
    color: var(--piui-text);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .references__text,
  .references__note {
    grid-column: 2;
    overflow-wrap: anywhere;
  }
  .references__text {
    color: var(--piui-text-muted);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
  }
  .references__note {
    color: var(--piui-warning-text);
    font-size: var(--piui-text-xs);
  }
</style>
