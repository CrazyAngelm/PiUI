<script lang="ts">
  import { onMount } from 'svelte';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import type { PluginValue } from '../../../../../contracts/piui-plugin-v1';
  import type { GraphNode } from '../../features/orchestration/agentGraph';
  import { t } from '../../features/locale/language';
  import type { PipelineEditorStore } from '../pipelines/editorStore.svelte';
  import PluginFieldsForm from './PluginFieldsForm.svelte';
  import { pluginRegistry } from './pluginRegistry.svelte';

  /**
   * The inspector of a plugin node (orchestration v6.5): a form PiUI builds
   * from the node type's declared configuration. The plugin's backend runs
   * the node on this computer when a pipeline reaches it.
   */
  interface Props {
    editor: PipelineEditorStore;
    node: GraphNode;
  }
  let { editor, node }: Props = $props();

  onMount(() => {
    void pluginRegistry.start();
  });

  const executor = $derived(node.executor?.type === 'plugin' ? node.executor : undefined);
  const found = $derived(executor ? pluginRegistry.nodeType(executor.pluginId, executor.nodeType) : undefined);
  const available = $derived(found !== undefined && found.plugin.active && found.plugin.permissions.includes('node.run'));

  function change(key: string, value: PluginValue | undefined): void {
    if (!executor) return;
    const config = { ...executor.config };
    if (value === undefined) delete config[key];
    else config[key] = value;
    editor.updateNode(node.id, { executor: { ...executor, config } }, true);
  }
</script>

{#if executor}
  <div class="plugin">
    <p class="warning" role="note">
      <TriangleAlert size={14} />
      <span>{$t("Runs in the plugin's backend on this computer, in trusted projects only. It is not a sandbox.")}</span>
    </p>
    {#if found}
      <div class="about">
        <strong>{found.nodeType.title}</strong>
        <small>{$t('From the plugin {0}', [found.plugin.name])} · {$t('{0} s limit', [found.nodeType.timeoutSeconds])}</small>
        {#if found.nodeType.description}<p>{found.nodeType.description}</p>{/if}
      </div>
    {/if}
    {#if !available}
      <p class="missing" role="alert">
        {$t('This plugin node needs its plugin: install and enable it in Settings → Plugins.')}
        <code>{executor.pluginId} · {executor.nodeType}</code>
      </p>
    {/if}
    {#if found && found.nodeType.config.length}
      <div role="group" aria-label={$t('Node configuration')}>
        <PluginFieldsForm
          fields={found.nodeType.config}
          values={executor.config}
          idPrefix="plugin-node-{node.id}"
          disabled={editor.readOnly}
          onChange={change}
        />
      </div>
    {:else if found}
      <p class="hint">{$t('This node type has no settings.')}</p>
    {/if}
    <details class="help">
      <summary>{$t('How a plugin node gets and returns data')}</summary>
      <p>{$t('It receives the run inputs, the result of every step it depends on and its configuration, and returns text or one JSON object, checked against the result fields like a script’s output.')}</p>
    </details>
  </div>
{/if}

<style>
  .plugin {
    display: grid;
    gap: var(--piui-space-4);
  }
  .warning,
  .missing {
    display: flex;
    flex-wrap: wrap;
    gap: var(--piui-space-2);
    margin: 0;
    padding: var(--piui-space-2) var(--piui-space-3);
    border-radius: var(--piui-radius-sm);
    font-size: var(--piui-text-sm);
  }
  .warning {
    border: 1px solid var(--piui-warning-border);
    background: var(--piui-warning-surface);
    color: var(--piui-warning-text);
  }
  .missing {
    border: 1px solid var(--piui-danger-border);
    background: var(--piui-danger-surface);
    color: var(--piui-danger-text);
  }
  .about {
    display: grid;
    gap: 2px;
  }
  .about p {
    margin: var(--piui-space-1) 0 0;
    color: var(--piui-text-muted);
  }
  small,
  .hint {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  code {
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-sm);
  }
  .help summary {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    cursor: pointer;
  }
  .help p {
    margin: var(--piui-space-2) 0 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
</style>
