<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../../features/locale/language';
  import { pluginsError, pluginsHost } from '../../host-api/pluginsClient';
  import { toasts } from '../../lib/ui';
  import { pluginRegistry } from './pluginRegistry.svelte';

  /**
   * Pipeline templates of active plugins next to the built-in ones. A
   * template is a portable system file (v4): it opens through the same
   * import as a file, so the existing parser checks it and it becomes a new
   * unsaved draft. Nothing runs.
   */
  interface Props {
    disabled: boolean;
    onImport: (text: string) => void;
  }
  let { disabled, onImport }: Props = $props();

  onMount(() => {
    void pluginRegistry.start();
  });
  const templates = $derived(pluginRegistry.templates());
  let loading = $state('');

  async function open(pluginId: string, templateId: string): Promise<void> {
    if (loading) return;
    loading = `${pluginId}/${templateId}`;
    try {
      onImport(await pluginsHost.template({ pluginId, templateId }));
    } catch (error) {
      toasts.error($t('The template could not be opened'), $t(pluginsError(error).message));
    } finally {
      loading = '';
    }
  }
</script>

{#each templates as { plugin, template } (`${plugin.id}/${template.id}`)}
  <button type="button" class="template" disabled={disabled || !!loading} onclick={() => void open(plugin.id, template.id)}>
    <strong>{template.title}</strong>
    <span>{template.description ?? ''}</span>
    <small>{$t('Plugin: {0}', [plugin.name])}</small>
  </button>
{/each}

<style>
  .template {
    display: grid;
    gap: 4px;
    padding: var(--piui-space-3);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-surface-1);
    color: var(--piui-text);
    text-align: left;
  }
  .template:hover:not(:disabled) {
    border-color: var(--piui-accent);
  }
  .template:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
  .template span,
  .template small {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    line-height: 1.4;
  }
</style>
