<script lang="ts">
  import ArrowRightLeft from '@lucide/svelte/icons/arrow-right-left';
  import { t } from '../../features/locale/language';
  import { Button } from '../../lib/ui';
  import { useWorkspace } from '../shell/context';
  import { newChatPlacement } from '../worktrees/newChatPlacement.svelte';
  import { cancelHandoff } from './startHandoff';

  const store = useWorkspace();
  const handoff = $derived(newChatPlacement.handoff);
</script>

{#if handoff}
  <div class="handoff" role="status">
    <ArrowRightLeft size={15} />
    <p>
      {$t('Continuing "{0}" from {1}. Pick a harness and model, edit the message, then send it. The new chat links back; the original stays as it is.', [handoff.sourceTitle, handoff.sourceHarness])}
    </p>
    <Button size="sm" variant="ghost" onclick={() => cancelHandoff(store)}>{$t('Cancel')}</Button>
  </div>
{/if}

<style>
  .handoff {
    display: flex;
    align-items: center;
    gap: var(--piui-space-3);
    margin-bottom: var(--piui-space-3);
    padding: var(--piui-space-2) var(--piui-space-2) var(--piui-space-2) var(--piui-space-3);
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-md);
    background: var(--piui-surface-1);
    color: var(--piui-text-muted);
  }
  .handoff :global(svg) {
    flex: none;
    color: var(--piui-accent);
  }
  p {
    flex: 1;
    margin: 0;
    font-size: var(--piui-text-sm);
    line-height: var(--piui-leading-normal);
  }
</style>
