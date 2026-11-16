<script lang="ts">
  import { parseTimestamp } from '../../host-api/projectsClient';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import X from '@lucide/svelte/icons/x';
  import Check from '@lucide/svelte/icons/check';
  import Minus from '@lucide/svelte/icons/minus';
  import Workflow from '@lucide/svelte/icons/workflow';
  import { t } from '../../features/locale/language';
  import { statusLabel } from '../../features/workspace/workspaceState';
  import type { SessionSnapshot } from '../../host-api/workspaceClient';
  import type { Capability, HarnessCapabilities } from '../../../../../contracts/workspace-v15';
  import { Button, IconButton } from '../../lib/ui';
  import { harnessMeta } from '../harnessMeta';
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
  const workspace = $derived(store.catalog.workspaces.find((item) => item.id === session.workspaceId));
  const harness = $derived(store.catalog.harnesses.find((item) => item.kind === session.harness));

  const CAPABILITY_LABELS: Record<keyof HarnessCapabilities, string> = {
    prompt: 'Accepts messages',
    resume: 'Resumes after restart',
    models: 'Model switching',
    approvals: 'Asks before risky actions',
    instructions: 'Custom instructions',
    toolPolicy: 'Tool restrictions',
    nativeSubagents: 'Own subagents',
  };
  function enforcementNote(capability: Capability): string {
    if (!capability.supported) return $t(capability.reason ?? 'Not available');
    switch (capability.enforcement) {
      case 'native':
        return $t('Enforced by the harness');
      case 'coordinator':
        return $t('Enforced by Nano Desktop');
      case 'advisory':
        return $t('Advisory only');
      default:
        return '';
    }
  }
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

    <details class="about">
      <summary><ChevronRight size={13} aria-hidden="true" /> {$t('About this chat')}</summary>
      <div class="about__body">
        <dl>
          <div><dt>{$t('Agent')}</dt><dd>{harnessMeta(session.harness).label}{#if harness?.version} <span class="muted">v{harness.version}</span>{/if}</dd></div>
          <div><dt>{$t('Model')}</dt><dd>{session.model?.name ?? $t('Harness default')}{#if session.model?.provider} <span class="muted">· {session.model.provider}</span>{/if}</dd></div>
          <div><dt>{$t('Status')}</dt><dd>{$t(statusLabel(session.status))}</dd></div>
          <div><dt>{$t('Project')}</dt><dd>{workspace ? (workspace.personal ? $t('Personal chats') : workspace.name) : '—'}{#if workspace && !workspace.personal} <span class="muted">· {workspace.trust === 'trusted' ? $t('trusted') : $t('restricted')}</span>{/if}</dd></div>
          <div><dt>{$t('Updated')}</dt><dd>{Number.isFinite(parseTimestamp(session.updatedAt)) ? new Date(parseTimestamp(session.updatedAt)).toLocaleString() : '—'}</dd></div>
        </dl>

        <section>
          <h3>{$t('What this agent can do here')}</h3>
          <ul class="caps">
            {#each Object.entries(snapshot.capabilities) as [name, capability] (name)}
              <li class:off={!capability.supported}>
                <span class="caps__icon">{#if capability.supported}<Check size={13} />{:else}<Minus size={13} />{/if}</span>
                <span class="caps__text">
                  <span>{$t(CAPABILITY_LABELS[name as keyof HarnessCapabilities] ?? name)}</span>
                  <small>{enforcementNote(capability)}</small>
                </span>
              </li>
            {/each}
          </ul>
        </section>
      </div>
    </details>
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
  h3 {
    margin: 0 0 var(--piui-space-2);
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-semibold);
  }
  .caps {
    display: grid;
    gap: var(--piui-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .caps li {
    display: flex;
    gap: var(--piui-space-2);
  }
  .caps__icon {
    display: inline-flex;
    margin-top: 2px;
    color: var(--piui-success);
  }
  .off .caps__icon {
    color: var(--piui-text-disabled);
  }
  .caps__text {
    display: grid;
  }
  .caps__text small {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .off .caps__text > span {
    color: var(--piui-text-muted);
  }
  .muted {
    color: var(--piui-text-muted);
  }
  .about summary {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 4px;
    margin-left: -4px;
    border-radius: var(--piui-radius-sm);
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-semibold);
    cursor: pointer;
    list-style: none;
  }
  .about summary::-webkit-details-marker {
    display: none;
  }
  .about summary :global(svg) {
    flex: none;
    transition: transform 120ms ease;
  }
  .about[open] summary :global(svg) {
    transform: rotate(90deg);
  }
  :global(:root[data-reduced-motion='reduce']) .about summary :global(svg) {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .about summary :global(svg) { transition: none; }
  }
  .about summary:hover {
    color: var(--piui-text);
  }
  .about summary:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
  .about__body {
    display: grid;
    gap: var(--piui-space-6);
    margin-top: var(--piui-space-3);
  }
</style>
