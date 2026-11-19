<script lang="ts">
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import { t } from '../../features/locale/language';
  import type { OrchestrationRunV6 } from '../../host-api/orchestrationClient';
  import { Button, toasts } from '../../lib/ui';
  import { lazyPipelines } from '../chatPipelines/lazyPipelines.svelte';
  import { newChatPermission, readChoices } from '../shell/newChatChoice';
  import { useWorkspace } from '../shell/context';
  import { errorMessage } from '../workspaceStore.svelte';
  import { onDestroy } from 'svelte';
  import { chatOfRun, claimContinuation, releaseContinuation, rememberRunChat } from './runChatLink';

  interface Props {
    run: OrchestrationRunV6;
    workspaceId: string;
    safeMode: boolean;
  }
  let { run, workspaceId, safeMode }: Props = $props();
  const store = useWorkspace();

  let busy = $state(false);
  /** False once the person left this run: a continuation still under way then opens nothing. */
  let shown = true;
  onDestroy(() => (shown = false));
  const finished = $derived(run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled');
  const chat = $derived(chatOfRun(workspaceId, run, (id) => store.catalog.sessions.some((session) => session.id === id && !session.runId)));
  const available = $derived(store.catalog.harnesses.filter((item) => item.status === 'available').map((item) => item.kind));
  const title = $derived(run.definition.launchCommand?.name || run.definition.pipeline.name || $t('Untitled pipeline'));

  async function go(): Promise<void> {
    // Everything the continuation needs is read now: the props change as the person moves between runs.
    const target = run;
    const project = workspaceId;
    const name = title;
    const kinds = available;
    if (chat) {
      await store.openSession(chat);
      return;
    }
    const fallback = kinds[0];
    if (!fallback) {
      toasts.error($t('Could not continue the run'), $t('No agent is available.'));
      return;
    }
    if (!claimContinuation(project, target.id)) return;
    busy = true;
    try {
      const { chatPipelines } = await lazyPipelines.load();
      await chatPipelines.continueRun(store, {
        workspaceId: project,
        run: target,
        permissionMode: newChatPermission(readChoices(), project),
        fallbackHarness: fallback,
        available: kinds,
        title: name,
        onFiled: (sessionId) => rememberRunChat(project, target.id, sessionId),
        open: async (sessionId) => {
          if (shown) await store.openSession(sessionId);
        },
      });
    } catch (error) {
      toasts.error($t('Could not continue the run'), $t(errorMessage(error)));
    } finally {
      releaseContinuation(project, target.id);
      busy = false;
    }
  }
</script>

{#if finished || chat}
  <div class="continue" role="group" aria-label={$t('Talk to the agent about this run')}>
    <MessageSquare size={14} aria-hidden="true" />
    <span class="continue__text">
      {#if chat}
        {$t('This run belongs to a chat with its agent.')}
      {:else if run.status === 'succeeded'}
        {$t('Not quite right? Ask the agent to change the result.')}
      {:else}
        {$t('Talk it over with the agent that answers this pipeline.')}
      {/if}
    </span>
    <Button size="sm" variant={chat ? 'ghost' : 'primary'} loading={busy} disabled={busy || (safeMode && !chat)} onclick={() => void go()}>
      {chat ? $t('Back to the chat') : $t('Continue in a chat')}
    </Button>
    {#if safeMode && !chat}<span class="continue__note">{$t('Not available in safe mode.')}</span>{/if}
  </div>
{/if}

<style>
  .continue {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--piui-space-2) var(--piui-space-3);
    padding: 8px var(--piui-space-4);
    border-top: 1px solid var(--piui-border-subtle);
    background: var(--piui-bg-raised);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .continue__text {
    flex: 1 1 200px;
    min-width: 0;
  }
  .continue__note {
    flex-basis: 100%;
    font-size: var(--piui-text-xs);
  }
</style>
