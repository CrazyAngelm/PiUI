<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../../features/locale/language';
  import PluginPanelFrame from './PluginPanelFrame.svelte';
  import { pluginRegistry } from './pluginRegistry.svelte';

  /** Sandboxed panels of active plugins in the chat details (location `chat-details`). */
  interface Props {
    sessionId: string;
    title: string;
  }
  let { sessionId, title }: Props = $props();

  onMount(() => {
    void pluginRegistry.start();
  });
  const panels = $derived(pluginRegistry.panels('chat-details'));
</script>

{#each panels as { plugin, panel } (`${plugin.id}/${panel.id}`)}
  <section class="panel" aria-labelledby="plugin-panel-{plugin.id}-{panel.id}">
    <h3 id="plugin-panel-{plugin.id}-{panel.id}">{panel.title} <small>{$t('Plugin: {0}', [plugin.name])}</small></h3>
    <PluginPanelFrame {plugin} {panel} chat={{ id: sessionId, title }} />
  </section>
{/each}

<style>
  .panel {
    display: grid;
    gap: var(--piui-space-2);
  }
  h3 {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--piui-space-2);
    margin: 0;
    font-size: var(--piui-text-md);
    font-weight: var(--piui-weight-semibold);
  }
  small {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-regular);
  }
</style>
