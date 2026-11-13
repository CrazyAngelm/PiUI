<script lang="ts">
  import type { TimelineBlock } from '../../../host-api/types';
  import { rendererActivity } from '../../../host-api/pluginBridge';
  import { pluginRegistry } from '../../plugins/pluginRegistry.svelte';

  let { block, onFailure }: { block: TimelineBlock; onFailure: () => void } = $props();
  const renderer = $derived(pluginRegistry.renderer(block.toolName));
  const activity = $derived(rendererActivity(block));
  let Frame = $state<typeof import('../../plugins/PluginPanelFrame.svelte').default>();
  $effect(() => {
    let current = true;
    import('../../plugins/PluginPanelFrame.svelte')
      .then(module => { if (current) Frame = module.default; })
      .catch(() => { if (current) onFailure(); });
    return () => { current = false; };
  });
</script>

{#if Frame && renderer}
  <Frame plugin={renderer.plugin} panel={{ id: renderer.renderer.id, title: renderer.renderer.title, url: renderer.renderer.url }} chat={null} {activity} onStatus={status => { if (status === 'failed') onFailure(); }} />
{/if}
