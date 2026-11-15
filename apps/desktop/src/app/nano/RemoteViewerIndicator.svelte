<script lang="ts">
  import MonitorSmartphone from '@lucide/svelte/icons/monitor-smartphone';
  import { t } from '../../features/locale/language';
  import { nanoRemote as sharedRemote, type NanoRemote } from './nanoRemote.svelte';

  interface Props {
    /** Opens the screen where a browser is disconnected (Settings → Nano account). */
    onOpen: () => void;
    /** `sidebar` sits under the work location; `bar` ends the narrow window's top bar. */
    placement?: 'sidebar' | 'bar';
    /** Test seam; the sidebar uses the application's remote access state. */
    remote?: NanoRemote;
  }
  let { onOpen, placement = 'sidebar', remote = sharedRemote }: Props = $props();

  const count = $derived(remote.viewers.length);
  const label = $derived($t('Remote access: {0} connected', [String(count)]));
</script>

<!-- Shown only while a browser is connected, so remote control is never silent. -->
{#if count > 0}
  <div class="remote-indicator remote-indicator--{placement}">
    <button type="button" class="indicator" aria-label={label} title={label} onclick={onOpen}>
      <MonitorSmartphone size={18} aria-hidden="true" />
      {#if count > 1}<span class="indicator__count" aria-hidden="true">{count}</span>{/if}
    </button>
  </div>
{/if}

<style>
  .remote-indicator {
    display: flex;
  }
  .remote-indicator--sidebar {
    padding: 0 0 var(--piui-space-2);
  }
  .remote-indicator--bar {
    margin-left: auto;
  }
  .indicator {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--piui-space-1);
    min-width: var(--piui-control-md);
    height: var(--piui-control-md);
    padding: 0 var(--piui-space-2);
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: var(--piui-accent-soft);
    color: var(--piui-accent);
  }
  .indicator__count {
    font-size: var(--piui-text-sm);
    font-variant-numeric: tabular-nums;
  }
  .indicator:hover {
    background: var(--piui-hover);
  }
  .indicator:focus-visible {
    outline: 2px solid var(--piui-accent);
    outline-offset: 2px;
  }
</style>
