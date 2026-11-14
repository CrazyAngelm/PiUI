<script lang="ts">
  import { t } from '../../features/locale/language';
  import Spinner from './Spinner.svelte';

  let { failed, label, retry }: { failed: boolean; label: string; retry: () => void } = $props();
  let retryButton = $state<HTMLButtonElement>();
  $effect(() => { if (failed) retryButton?.focus(); });
</script>

<div class="pending" role="status" aria-label={label} aria-busy={!failed}>
  {#if failed}
    <span>{$t('This view could not be loaded')}</span>
    <button bind:this={retryButton} type="button" onclick={retry}>{$t('Retry')}</button>
  {:else}
    <Spinner />
  {/if}
</div>

<style>
  .pending { display: flex; align-items: center; gap: var(--piui-space-2); padding: var(--piui-space-3); border: 1px solid var(--piui-border); border-radius: var(--piui-radius-md); background: var(--piui-surface-1); color: var(--piui-text); box-shadow: var(--piui-shadow-2); }
  button { border: 0; border-radius: var(--piui-radius-sm); padding: var(--piui-space-1) var(--piui-space-2); background: var(--piui-action); color: var(--piui-action-ink); font: inherit; }
  button:focus-visible { outline: 2px solid var(--piui-focus); outline-offset: 2px; }
</style>
