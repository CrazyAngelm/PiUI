<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import Workflow from '@lucide/svelte/icons/workflow';
  import { t } from '../../features/locale/language';
  import type { SessionSnapshot } from '../../host-api/workspaceClient';
  import { Button, IconButton } from '../../lib/ui';
  import AgentModePicker from './AgentModePicker.svelte';
  import ChatOrigin from '../worktrees/ChatOrigin.svelte';
  import LinkedChats from '../links/LinkedChats.svelte';
  import { sessionNotices } from '../../features/workspace/sessionNotices';
  import PluginChatPanels from '../plugins/PluginChatPanels.svelte';
  import SessionActivity from '../chat/activity/SessionActivity.svelte';
  import { useWorkspace } from './context';
  import { remoteMode } from '../nano/remoteMode';

  interface Props {
    snapshot: SessionSnapshot;
    /** A member of a managed run or a Fusion sidekick: the host refuses to stop its tasks from this window. */
    managed: boolean;
    onClose: () => void;
    /** Opens the review panel of this chat. */
    onReview?: () => void;
  }
  let { snapshot, managed, onClose, onReview }: Props = $props();
  const store = useWorkspace();

  const session = $derived(snapshot.session);
</script>

<aside class="details" aria-label={$t('Chat details')}>
  <header>
    <h2>{$t('Details')}</h2>
    <IconButton label={$t('Close details')} size="sm" onclick={onClose}><X /></IconButton>
  </header>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (The scroll region must support keyboard scrolling.) -->
  <div class="body" tabindex="0" role="region" aria-label={$t('Details')}>
    <SessionActivity {snapshot} canStop={!remoteMode && !store.safeMode && !managed} />

    <!-- Worktrees, handoff links and review belong to this computer's screen; a remote browser has none. -->
    {#if !remoteMode}<LinkedChats sessionId={session.id} harness={session.harness} notices={sessionNotices(snapshot)} />{/if}
    {#if !remoteMode}<ChatOrigin sessionId={session.id} {onReview} />{/if}

    {#if snapshot.modes}
      <dl>
        <div><dt>{$t('Mode')}</dt><dd><AgentModePicker sessionId={session.id} modes={snapshot.modes} disabled={store.safeMode || session.status === 'closed' || session.status === 'failed'} onChanged={() => store.reconcileSession(session.id)} /></dd></div>
      </dl>
    {/if}

    {#if session.runId && !remoteMode}
      <Button size="sm" onclick={() => store.openRun(session.workspaceId, session.runId)}>
        {#snippet leading()}<Workflow />{/snippet}
        {$t('Part of a pipeline run')}
      </Button>
    {/if}

    {#if !remoteMode}<PluginChatPanels sessionId={session.id} title={session.title} />{/if}
  </div>
</aside>

<style>
  .details {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--piui-border-subtle);
    background: var(--piui-bg-raised);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: var(--piui-header-height);
    padding: 0 var(--piui-space-2) 0 var(--piui-space-4);
    border-bottom: 1px solid var(--piui-border-subtle);
    flex: none;
  }
  h2 {
    margin: 0;
    font-size: var(--piui-text-md);
    font-weight: var(--piui-weight-semibold);
  }
  .body {
    display: grid;
    align-content: start;
    gap: var(--piui-space-6);
    padding: var(--piui-space-4);
    overflow-y: auto;
  }
  dl {
    display: grid;
    gap: var(--piui-space-3);
    margin: 0;
  }
  dl div {
    display: grid;
    gap: 2px;
  }
  dt {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }
  dd {
    margin: 0;
    word-break: break-word;
  }
</style>
