<script lang="ts">
  import { parseTimestamp } from '../../host-api/projectsClient';
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
  import PluginChatPanels from '../plugins/PluginChatPanels.svelte';
  import { useWorkspace } from './context';

  interface Props {
    snapshot: SessionSnapshot;
    onClose: () => void;
    onDelete: () => void;
  }
  let { snapshot, onClose, onDelete }: Props = $props();
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
    if (!capability.supported) return capability.reason ?? $t('Not available');
    switch (capability.enforcement) {
      case 'native':
        return $t('Enforced by the harness');
      case 'coordinator':
        return $t('Enforced by PiUI');
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
  <div class="body">
    <dl>
      <div><dt>{$t('Agent')}</dt><dd>{harnessMeta(session.harness).label}{#if harness?.version} <span class="muted">v{harness.version}</span>{/if}</dd></div>
      <div><dt>{$t('Model')}</dt><dd>{session.model?.name ?? $t('Harness default')}{#if session.model?.provider} <span class="muted">· {session.model.provider}</span>{/if}</dd></div>
      {#if snapshot.modes}<div><dt>{$t('Mode')}</dt><dd><AgentModePicker sessionId={session.id} modes={snapshot.modes} disabled={store.safeMode || session.status === 'closed' || session.status === 'failed'} onChanged={() => store.reconcileSession(session.id)} /></dd></div>{/if}
      <div><dt>{$t('Status')}</dt><dd>{$t(statusLabel(session.status))}</dd></div>
      <div><dt>{$t('Project')}</dt><dd>{workspace ? (workspace.personal ? $t('Personal chats') : workspace.name) : '—'}{#if workspace && !workspace.personal} <span class="muted">· {workspace.trust === 'trusted' ? $t('trusted') : $t('restricted')}</span>{/if}</dd></div>
      <div><dt>{$t('Updated')}</dt><dd>{Number.isFinite(parseTimestamp(session.updatedAt)) ? new Date(parseTimestamp(session.updatedAt)).toLocaleString() : '—'}</dd></div>
    </dl>

    {#if session.runId}
      <Button size="sm" onclick={() => store.openRun(session.workspaceId, session.runId)}>
        {#snippet leading()}<Workflow />{/snippet}
        {$t('Part of a pipeline run')}
      </Button>
    {/if}

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

    <PluginChatPanels sessionId={session.id} title={session.title} />

    <section class="danger">
      {#if session.status !== 'closed'}
        <Button size="sm" variant="ghost" onclick={() => void store.close(session.id)} disabled={store.sessionActionBusy}>{$t('Stop agent process')}</Button>
      {/if}
      {#if !session.runId}
        <Button size="sm" variant="danger" onclick={onDelete} disabled={store.safeMode || !['idle', 'closed', 'failed'].includes(session.status)}>{$t('Delete chat…')}</Button>
      {/if}
      <p class="muted small">{$t('Deleting removes the chat from PiUI. The harness keeps its own history.')}</p>
    </section>
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
  .danger {
    display: grid;
    justify-items: start;
    gap: var(--piui-space-2);
    padding-top: var(--piui-space-4);
    border-top: 1px solid var(--piui-border-subtle);
  }
  .muted {
    color: var(--piui-text-muted);
  }
  .small {
    margin: 0;
    font-size: var(--piui-text-sm);
  }
</style>
