<script lang="ts">
  import Monitor from '@lucide/svelte/icons/monitor';
  import Cloud from '@lucide/svelte/icons/cloud';
  import { t } from '../../features/locale/language';
  import { nanoAccount } from './nanoAccount.svelte';
  import { openNanoCloud } from './openCloud';
</script>

{#if nanoAccount.canUseCloud}
  <div class="locations" role="group" aria-label={$t('Work location')}>
    <span class="location current" aria-current="location"><Monitor size={14} />{$t('This computer')}</span>
    <button class="location" type="button" aria-label={$t('Open Nano Cloud')} title={$t('Open Nano Cloud')}
      disabled={nanoAccount.action === 'cloud'} onclick={() => void openNanoCloud()}>
      <Cloud size={14} /><span>Nano Cloud</span>
    </button>
  </div>
{/if}

<style>
  .locations { display: flex; align-items: stretch; gap: var(--piui-space-1); padding: var(--piui-space-1) 0 var(--piui-space-2); }
  .location { display: inline-flex; align-items: center; justify-content: center; gap: var(--piui-space-1); flex: 1; min-width: 0; padding: var(--piui-space-2) var(--piui-space-1); border: 0; border-radius: var(--piui-radius-sm); background: transparent; color: var(--piui-text-muted); font: inherit; font-size: var(--piui-text-xs); }
  .current { background: var(--piui-surface-1); color: var(--piui-text); }
  button:hover { background: var(--piui-hover); color: var(--piui-text); }
  button:disabled { opacity: .5; }
  button:focus-visible { outline: 2px solid var(--piui-accent); outline-offset: 2px; }
</style>
