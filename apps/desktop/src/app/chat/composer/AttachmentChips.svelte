<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import { t } from '../../../features/locale/language';
  import type { ComposerImage } from '../../../host-api/composerInputsClient';
  import { IconButton } from '../../../lib/ui';
  import ImageThumb from './ImageThumb.svelte';

  interface Props {
    images: readonly ComposerImage[];
    disabled?: boolean;
    onRemove: (id: string) => void;
  }
  let { images, disabled = false, onRemove }: Props = $props();

  function size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

{#if images.length}
  <ul class="chips" aria-label={$t('Attached images')}>
    {#each images as image (image.id)}
      <li class="chip">
        <ImageThumb id={image.id} label={$t('Preview of {0}', [image.name])} />
        <span class="chip__text">
          <span class="chip__name" title={image.name}>{image.name}</span>
          <span class="chip__size">{size(image.size)}</span>
        </span>
        <IconButton size="sm" label={$t('Remove {0}', [image.name])} {disabled} onclick={() => onRemove(image.id)}><X /></IconButton>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 10px 12px 0;
    list-style: none;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 240px;
    padding: 4px 4px 4px 4px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-bg-raised);
  }
  .chip__text {
    display: grid;
    min-width: 0;
  }
  .chip__name {
    overflow: hidden;
    color: var(--piui-text);
    font-size: var(--piui-text-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip__size {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
</style>
