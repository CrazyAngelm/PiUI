<script lang="ts">
  import Monitor from '@lucide/svelte/icons/monitor';
  import Cloud from '@lucide/svelte/icons/cloud';
  import { t } from '../../features/locale/language';
  import { nanoAccount } from './nanoAccount.svelte';
  import { openNanoCloud } from './openCloud';
</script>

{#if nanoAccount.canUseCloud}
  <div class="locations" role="group" aria-label={$t('Work location')}>
    <span class="location current" role="img" aria-current="location" aria-label={$t('This computer')} title={$t('This computer')}>
      <Monitor size={18} aria-hidden="true" />
    </span>
    <button class="location" type="button" aria-label={$t('Open Nano Cloud')} title={$t('Open Nano Cloud')}
      disabled={nanoAccount.action === 'cloud'} onclick={() => void openNanoCloud()}>
      <Cloud size={18} aria-hidden="true" />
    </button>
  </div>
{/if}

<style>
  .locations { display: flex; flex-direction: column; align-items: center; gap: var(--piui-space-1); }
  .location { display: inline-flex; align-items: center; justify-content: center; flex: none; width: var(--piui-control-md); height: var(--piui-control-md); padding: 0; border: 0; border-radius: var(--piui-radius-sm); background: transparent; color: var(--piui-text-muted); }
  .current { background: var(--piui-surface-1); color: var(--piui-text); }
  button:hover { background: var(--piui-hover); color: var(--piui-text); }
  button:disabled { opacity: .5; }
  button:focus-visible { outline: 2px solid var(--piui-accent); outline-offset: 2px; }
</style>
