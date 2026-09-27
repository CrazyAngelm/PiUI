<script lang="ts">
  import { onMount } from 'svelte';
  import type { PluginEntryV1, PluginStatusItemV1 } from '../../../../../contracts/plugins-v1';
  import { t } from '../../features/locale/language';
  import { isMac } from '../../lib/ui';
  import { useWorkspace } from '../shell/context';
  import { runRegistryCommand } from './commands';
  import { pluginRegistry, type RegistryCommand } from './pluginRegistry.svelte';
  import { matchesPluginShortcut, resolveKeybindings } from './pluginShortcuts';

  /**
   * App-wide plugin contributions (plugins v2), loaded after first paint:
   * the status bar with the items of active plugins (shown only when there
   * is one) and their keybindings. A binding runs only when no dialog is
   * open and never on a PiUI shortcut or a key two plugins share. Commands
   * prepare text for review exactly like the palette; nothing is sent.
   */
  const store = useWorkspace();

  onMount(() => {
    void pluginRegistry.start();
  });

  interface Item {
    readonly key: string;
    readonly plugin: PluginEntryV1;
    readonly item: PluginStatusItemV1;
  }

  const items = $derived<Item[]>(
    pluginRegistry.active
      .filter((plugin) => plugin.permissions.includes('ui.status'))
      .flatMap((plugin) => (plugin.contributes.statusItems ?? []).map((item) => ({ key: `${plugin.id}:${item.id}`, plugin, item }))),
  );
  const start = $derived(items.filter((entry) => entry.item.alignment === 'start'));
  const end = $derived(items.filter((entry) => entry.item.alignment !== 'start'));
  const bindings = $derived(resolveKeybindings(pluginRegistry.active).filter((binding) => binding.conflict === undefined));

  function registryCommand(plugin: PluginEntryV1, commandId: string): RegistryCommand | undefined {
    const command = plugin.contributes.commands.find((candidate) => candidate.id === commandId);
    return command ? { key: `plugin:${plugin.id}:${command.id}`, source: 'plugin', pluginId: plugin.id, pluginName: plugin.name, command } : undefined;
  }

  function runItem(entry: Item): void {
    const command = entry.item.command ? registryCommand(entry.plugin, entry.item.command) : undefined;
    if (command) void runRegistryCommand(command, 'status', store.selectedSession?.id, $t);
  }

  function keydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.repeat || event.isComposing || !bindings.length) return;
    // A dialog owns the keyboard: plugin shortcuts wait until it closes.
    if (document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]')) return;
    const binding = bindings.find((candidate) => matchesPluginShortcut(event, candidate.key, isMac));
    if (!binding) return;
    event.preventDefault();
    const command = registryCommand(binding.plugin, binding.command.id);
    if (command) void runRegistryCommand(command, 'keybinding', store.selectedSession?.id, $t);
  }
</script>

<svelte:window onkeydown={keydown} />

{#snippet entry(entry: Item)}
  {@const label = entry.item.tooltip ?? entry.item.text}
  {#if entry.item.command}
    <button type="button" class="item item--action" title={label} aria-label={$t('{0} (plugin {1})', [label, entry.plugin.name])} onclick={() => runItem(entry)}>
      {entry.item.text}
    </button>
  {:else}
    <span class="item" title={label}>{entry.item.text}</span>
  {/if}
{/snippet}

{#if items.length && !pluginRegistry.safeMode}
  <footer class="status" aria-label={$t('Plugin status items')}>
    <div class="group">
      {#each start as item (item.key)}{@render entry(item)}{/each}
    </div>
    <div class="group group--end">
      {#each end as item (item.key)}{@render entry(item)}{/each}
    </div>
  </footer>
{/if}

<style>
  .status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-3);
    min-height: 24px;
    padding: 0 var(--piui-space-2);
    border-top: 1px solid var(--piui-border-subtle);
    background: var(--piui-bg-raised);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    flex: none;
  }
  .group {
    display: flex;
    align-items: center;
    gap: var(--piui-space-1);
    min-width: 0;
  }
  .group--end {
    justify-content: flex-end;
  }
  .item {
    max-width: 24ch;
    overflow: hidden;
    padding: 2px var(--piui-space-2);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .item--action {
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: inherit;
    font: inherit;
  }
  .item--action:hover {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .item--action:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: -2px;
  }
</style>
