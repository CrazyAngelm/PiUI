<script lang="ts">
  import AlarmClock from '@lucide/svelte/icons/alarm-clock';
  import FolderSync from '@lucide/svelte/icons/folder-sync';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import Zap from '@lucide/svelte/icons/zap';
  import { t } from '../../features/locale/language';
  import type { RunTrigger } from '../../host-api/orchestrationClient';
  import { MAX_TRIGGER_CHAIN_DEPTH } from '../../../../../contracts/orchestration-v6';
  import { shortId } from './runPresentation';

  interface Props {
    /** What started the run (v6.3); nothing is shown for a person's manual start. */
    trigger: RunTrigger | undefined;
    onOpenRun: (runId: string) => void;
  }
  let { trigger, onOpenRun }: Props = $props();
</script>

{#if trigger}
  <span class="trigger">
    {#if trigger.kind === 'schedule'}
      <AlarmClock size={13} aria-hidden="true" />
      <span>{$t('Started by {0}', [trigger.scheduleName])}</span>
    {:else if trigger.kind === 'event'}
      {#if trigger.event === 'run-finished'}
        <Zap size={13} aria-hidden="true" />
        <span>{$t('Started by {0} after run', [trigger.scheduleName])}</span>
        {#if trigger.sourceRunId}
          {@const source = trigger.sourceRunId}
          <button type="button" class="link" aria-label={$t('Open run {0}', [shortId(source)])} onclick={() => onOpenRun(source)}>#{shortId(source)}</button>
        {/if}
      {:else}
        <FolderSync size={13} aria-hidden="true" />
        <span>{$t('Started by {0} when files changed', [trigger.scheduleName])}</span>
      {/if}
      {#if trigger.chainDepth > 1}
        <span class="depth">· {$t('chained run {0} of {1}', [trigger.chainDepth, MAX_TRIGGER_CHAIN_DEPTH])}</span>
      {/if}
    {:else}
      <MessageSquare size={13} aria-hidden="true" />
      <span>{$t('Started from a chat')}</span>
    {/if}
  </span>
{/if}

<style>
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .trigger > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .depth {
    flex: none;
  }
  .link {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--piui-accent);
    font: inherit;
    cursor: pointer;
  }
  .link:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
</style>
