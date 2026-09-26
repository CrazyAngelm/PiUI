<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from '../../features/locale/language';
  import { Button, Dialog } from '../../lib/ui';

  /** One explicit decision about an ACP agent: confirm a version or remove it. */
  interface Props {
    open: boolean;
    title: string;
    confirmLabel: string;
    confirmVariant?: 'primary' | 'danger';
    busy: boolean;
    error: string | undefined;
    children: Snippet;
    onConfirm: () => void;
  }
  let { open = $bindable(), title, confirmLabel, confirmVariant = 'primary', busy, error, children, onConfirm }: Props = $props();
</script>

<Dialog bind:open {title} size="sm" closeLabel={$t('Close')}>
  <div class="body">
    {@render children()}
    {#if error}<p class="error" role="alert">{$t(error)}</p>{/if}
  </div>
  {#snippet footer()}
    <Button onclick={() => (open = false)}>{$t('Cancel')}</Button>
    <Button variant={confirmVariant} loading={busy} onclick={onConfirm}>{confirmLabel}</Button>
  {/snippet}
</Dialog>

<style>
  .body {
    display: grid;
    gap: var(--piui-space-3);
    line-height: var(--piui-leading-normal);
  }
  .body :global(p) {
    margin: 0;
  }
  .body :global(.muted) {
    color: var(--piui-text-muted);
  }
  .error {
    color: var(--piui-danger-text);
  }
</style>
