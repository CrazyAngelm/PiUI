<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../../features/locale/language';
  import { pluginsError } from '../../host-api/pluginsClient';
  import { toasts } from '../../lib/ui';
  import { useWorkspace } from '../shell/context';
  import { pluginRegistry } from './pluginRegistry.svelte';
  import { startPluginTheme } from './pluginTheme.svelte';

  /**
   * Settings → General: the themes of active plugins next to System, Dark and
   * Light. Choosing one switches PiUI to its appearance; choosing another
   * appearance hides it again (it returns with its appearance).
   */
  const store = useWorkspace();
  onMount(() => {
    startPluginTheme();
  });

  let busy = $state(false);
  const themes = $derived(pluginRegistry.themes());
  const selected = $derived.by(() => {
    const active = pluginRegistry.registry?.activeTheme;
    return active && themes.some(({ plugin, theme }) => plugin.id === active.pluginId && theme.id === active.themeId)
      ? JSON.stringify([active.pluginId, active.themeId])
      : '';
  });

  async function choose(value: string): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      if (value === '') {
        await pluginRegistry.run({ type: 'setTheme', expectedRevision: pluginRegistry.revision, theme: null });
        return;
      }
      const [pluginId, themeId] = JSON.parse(value) as [string, string];
      const choice = themes.find(({ plugin, theme }) => plugin.id === pluginId && theme.id === themeId);
      if (!choice) return;
      await pluginRegistry.run({ type: 'setTheme', expectedRevision: pluginRegistry.revision, theme: { pluginId, themeId } });
      if (store.preferences.theme !== choice.theme.appearance) await store.savePreferences({ ...store.preferences, theme: choice.theme.appearance });
    } catch (cause) {
      toasts.error($t('The theme did not change'), $t(pluginsError(cause).message));
    } finally {
      busy = false;
    }
  }
</script>

{#if themes.length && !pluginRegistry.safeMode}
  <div class="row">
    <div>
      <strong><label for="plugin-theme">{$t('Plugin theme')}</label></strong>
      <small>{$t('Colors from an installed plugin. They apply while PiUI shows their appearance.')}</small>
    </div>
    <select id="plugin-theme" class="select" value={selected} disabled={busy} onchange={(event) => void choose(event.currentTarget.value)}>
      <option value="">{$t('None')}</option>
      {#each themes as { plugin, theme } (`${plugin.id}/${theme.id}`)}
        <option value={JSON.stringify([plugin.id, theme.id])}>{theme.label} ({theme.appearance === 'dark' ? $t('Dark') : $t('Light')}) · {plugin.name}</option>
      {/each}
    </select>
  </div>
{/if}

<style>
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-4);
    padding: var(--piui-space-3) 0;
    border-bottom: 1px solid var(--piui-border-subtle);
  }
  .row div {
    display: grid;
    gap: 2px;
  }
  small {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .select {
    height: var(--piui-control-md);
    max-width: 320px;
    padding: 0 var(--piui-space-2);
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-surface-1);
    color: var(--piui-text);
    font: inherit;
  }
  .select option {
    background: var(--piui-surface-1);
    color: var(--piui-text);
  }
  .select:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
</style>
