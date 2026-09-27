<script lang="ts">
  import { Command } from 'bits-ui';
  import SquareSlash from '@lucide/svelte/icons/square-slash';
  import { t } from '../../features/locale/language';
  import type { NativeCommand } from '../../host-api/composerInputsClient';
  import { composerSupport } from '../../harness-adapters/composer';
  import { harnessMeta } from '../harnessMeta';
  import { loadComposerCatalog } from '../chat/composer/composerLookups.svelte';
  import { catalogReadable, COMMAND_SOURCE_LABELS, commandText, paletteNativeCommands } from '../chat/composer/paletteCommands';
  import { prepareInChat } from '../plugins/commands';
  import { pluginRegistry } from '../plugins/pluginRegistry.svelte';
  import { useWorkspace } from './context';

  /**
   * Ctrl+K: the open chat's native `/` commands (Pi extension, prompt
   * template and skill commands, or another harness's own commands), read
   * from the same live-session catalog as the composer's `/` menu. Choosing
   * one puts `/name ` in the chat's message box exactly like that menu; the
   * harness runs it when the message is sent. Nothing is sent from here.
   */
  interface Props {
    onDone: () => void;
  }
  let { onDone }: Props = $props();
  const store = useWorkspace();

  let commands = $state.raw<readonly NativeCommand[]>([]);
  const session = $derived(store.selectedSession);
  const wanted = $derived(
    session !== undefined && !store.safeMode && !session.runId && composerSupport(session.harness).nativeCommands && catalogReadable(session.status),
  );
  const harnessLabel = $derived(session === undefined ? '' : harnessMeta(session.harness).short);
  // Pi extension commands a manifest declares are already in "Plugin commands".
  const listedElsewhere = $derived(
    pluginRegistry.commands('palette', session?.harness).flatMap((command) => (command.source === 'pi-extension' ? [command.commandName] : [])),
  );
  const shown = $derived(paletteNativeCommands(commands, listedElsewhere));

  $effect(() => {
    const id = session?.id;
    if (!wanted || id === undefined) {
      commands = [];
      return;
    }
    let current = true;
    void loadComposerCatalog(id).then(
      (result) => {
        if (current) commands = result.commands;
      },
      () => {
        // A chat that stopped meanwhile has no catalog; the group stays empty.
        if (current) commands = [];
      },
    );
    return () => {
      current = false;
    };
  });

  function choose(command: NativeCommand): void {
    const id = session?.id;
    onDone();
    if (id !== undefined) void prepareInChat(id, commandText(command));
  }

  const badge = (command: NativeCommand): string => {
    const source = COMMAND_SOURCE_LABELS[command.source];
    return source === undefined ? harnessLabel : `${harnessLabel} · ${$t(source)}`;
  };
</script>

{#if shown.length}
  <Command.Group>
    <Command.GroupHeading class="palette__heading">{$t('{0} commands', [harnessLabel])}</Command.GroupHeading>
    <Command.GroupItems>
      {#each shown as command (command.name)}
        <Command.Item
          class="palette__item"
          value={`native:${command.name}`}
          keywords={[`/${command.name}`, command.name, command.description ?? '', 'slash', 'command']}
          onSelect={() => choose(command)}
        >
          <SquareSlash size={15} />
          <span class="label">/{command.name}</span>
          {#if command.description}<span class="description">{command.description}</span>{/if}
          <small>{badge(command)}</small>
        </Command.Item>
      {/each}
    </Command.GroupItems>
  </Command.Group>
{/if}

<style>
  .label {
    flex: none;
    max-width: 45%;
    overflow: hidden;
    font-family: var(--piui-font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .description {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--piui-text-muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
