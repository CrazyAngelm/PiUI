<script lang="ts">
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import { t } from '../../../features/locale/language';
  import type { ImageSupport } from '../../../harness-adapters/composer';
  import { Spinner, Tooltip } from '../../../lib/ui';

  interface Props {
    images: ImageSupport;
    busy?: boolean;
    /** The composer cannot take input at all (safe mode, sending). */
    disabled?: boolean;
    onPick: () => void;
  }
  let { images, busy = false, disabled = false, onPick }: Props = $props();
  const reasonId = `attach-reason-${Math.random().toString(36).slice(2)}`;
  // Unsupported stays focusable (aria-disabled) so its reason can be read.
  const unavailable = $derived(!images.supported);
  const hint = $derived(unavailable ? $t(images.reason ?? 'This harness does not accept images in PiUI.') : $t('Attach images or files'));
</script>

<Tooltip content={hint}>
  {#snippet trigger(props)}
    <button
      {...props}
      type="button"
      class="attach"
      aria-label={$t('Attach images or files')}
      aria-disabled={unavailable || undefined}
      aria-describedby={unavailable ? reasonId : undefined}
      disabled={disabled || busy}
      onclick={() => {
        if (!unavailable) onPick();
      }}
    >
      {#if busy}<Spinner size={14} />{:else}<Paperclip size={16} />{/if}
    </button>
  {/snippet}
</Tooltip>
{#if unavailable}<span id={reasonId} class="visually-hidden">{hint}</span>{/if}

<style>
  .attach {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: var(--piui-control-md);
    height: var(--piui-control-md);
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
    transition:
      background-color var(--piui-duration-fast) var(--piui-ease-out),
      color var(--piui-duration-fast) var(--piui-ease-out);
  }
  .attach:hover:not(:disabled):not([aria-disabled='true']) {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .attach[aria-disabled='true'],
  .attach:disabled {
    color: var(--piui-text-disabled);
    cursor: default;
  }
  .attach:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
</style>
