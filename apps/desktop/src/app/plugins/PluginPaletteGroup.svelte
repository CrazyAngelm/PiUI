<script lang="ts">
  import { onMount } from 'svelte';
  import { Command } from 'bits-ui';
  import Blocks from '@lucide/svelte/icons/blocks';
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import { t } from '../../features/locale/language';
  import { useWorkspace } from '../shell/context';
  import { runRegistryCommand } from './commands';
  import { commandSource, commandTitle, pluginRegistry, type RegistryCommand } from './pluginRegistry.svelte';

  /**
   * Ctrl+K: commands of active plugins and, in a Pi chat, the Pi extension
   * commands declared in `piui.manifest.json` (Tier 1A). Text a command
   * prepares goes to the open chat's message box for review; nothing is sent.
   */
  interface Props {
    onDone: () => void;
  }
  let { onDone }: Props = $props();
  const store = useWorkspace();

  onMount(() => {
    void pluginRegistry.start();
  });

  const session = $derived(store.selectedSession);
  $effect(() => {
    if (session?.harness === 'pi') void pluginRegistry.loadContributions();
  });
  const commands = $derived(pluginRegistry.commands('palette', session?.harness));

  function run(command: RegistryCommand): void {
    onDone();
    void runRegistryCommand(command, 'palette', session?.id, $t);
  }
</script>

{#if commands.length}
  <Command.Group>
    <Command.GroupHeading class="palette__heading">{$t('Plugin commands')}</Command.GroupHeading>
    <Command.GroupItems>
      {#each commands as command (command.key)}
        <Command.Item
          class="palette__item"
          value={command.key}
          keywords={[commandTitle(command), commandSource(command), 'plugin', 'extension']}
          onSelect={() => run(command)}
        >
          {#if command.source === 'plugin'}<Blocks size={15} />{:else}<Puzzle size={15} />{/if}
          <span class="label">{commandTitle(command)}</span>
          <small>{commandSource(command)}</small>
        </Command.Item>
      {/each}
    </Command.GroupItems>
  </Command.Group>
{/if}

<style>
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
