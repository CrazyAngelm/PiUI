<script lang="ts">
  import { onMount } from 'svelte';
  import Blocks from '@lucide/svelte/icons/blocks';
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import { t } from '../../features/locale/language';
  import { Button } from '../../lib/ui';
  import { runRegistryCommand } from './commands';
  import { commandSource, commandTitle, pluginRegistry, type RegistryCommand } from './pluginRegistry.svelte';

  /**
   * Composer actions of active plugins and, in a Pi chat, of Pi extension
   * manifests (Tier 1A). A click prepares text in this chat's message box —
   * an empty box takes it, a draft is kept and the text waits — and never
   * sends anything.
   */
  interface Props {
    sessionId: string;
    harness: string;
    disabled?: boolean;
  }
  let { sessionId, harness, disabled = false }: Props = $props();

  onMount(() => {
    void pluginRegistry.start();
  });
  $effect(() => {
    if (harness === 'pi') void pluginRegistry.loadContributions();
  });

  const actions = $derived(pluginRegistry.commands('composer', harness));
  let running = $state('');

  async function run(command: RegistryCommand): Promise<void> {
    if (running) return;
    running = command.key;
    try {
      await runRegistryCommand(command, 'composer', sessionId, $t);
    } finally {
      running = '';
    }
  }

  const describe = (command: RegistryCommand): string =>
    `${command.source === 'plugin' ? command.command.description ?? '' : command.description ?? ''} (${commandSource(command)})`.trim();
</script>

{#if actions.length}
  <div class="actions" role="group" aria-label={$t('Plugin actions')}>
    {#each actions as command (command.key)}
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled || (!!running && running !== command.key)}
        loading={running === command.key}
        title={describe(command)}
        onclick={() => void run(command)}
      >
        {#snippet leading()}
          {#if command.source === 'plugin'}<Blocks />{:else}<Puzzle />{/if}
        {/snippet}
        {commandTitle(command)}
      </Button>
    {/each}
  </div>
{/if}

<style>
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--piui-space-1);
  }
</style>
