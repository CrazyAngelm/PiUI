<script lang="ts">
  import InboxIcon from '@lucide/svelte/icons/inbox';
  import { t } from '../../features/locale/language';
  import { EmptyState, StatusDot } from '../../lib/ui';
  import { statusLabel } from '../../features/workspace/workspaceState';
  import { harnessMeta } from '../harnessMeta';
  import ApprovalCard from './ApprovalCard.svelte';
  import HarnessMark from './HarnessMark.svelte';
  import { useWorkspace } from './context';

  const store = useWorkspace();
  const items = $derived(store.inboxApprovals);
  const running = $derived(store.runningSessions);
  const failed = $derived(store.catalog.sessions.filter((session) => session.status === 'failed'));

  function origin(sessionId: string): string {
    const session = store.catalog.sessions.find((item) => item.id === sessionId);
    if (!session) return '';
    const workspace = store.catalog.workspaces.find((item) => item.id === session.workspaceId);
    const project = workspace ? (workspace.personal ? $t('Personal chats') : workspace.name) : '';
    return project ? `${session.title} · ${project}` : session.title;
  }
</script>

<section class="inbox" aria-labelledby="inbox-title">
  <header class="page-head">
    <h1 id="inbox-title">{$t('Inbox')}</h1>
    <p>{$t('Decisions and questions from all agents, pipelines and projects.')}</p>
  </header>

  <div class="content">
    {#if items.length === 0 && failed.length === 0}
      <EmptyState icon={InboxIcon} title={$t('Nothing needs you right now')} description={$t('Approvals, questions from agents and failed chats appear here.')} />
    {:else}
      {#if items.length}
        <h2>{$t('Waiting for your decision')} <span class="count">{items.length}</span></h2>
        <div class="list">
          {#each items as item (store.approvalKey(item.session.id, item.approval.id))}
            <ApprovalCard
              approval={item.approval}
              session={item.session}
              showOrigin
              originLabel={origin(item.session.id)}
              onOpen={() => void store.openSession(item.session.id)}
            />
          {/each}
        </div>
      {/if}
      {#if failed.length}
        <h2>{$t('Failed')} <span class="count">{failed.length}</span></h2>
        <ul class="rows">
          {#each failed as session (session.id)}
            <li>
              <button type="button" onclick={() => void store.openSession(session.id)}>
                <HarnessMark kind={session.harness} />
                <span class="rows__title">{session.title}</span>
                <StatusDot status="failed" />
                <span class="muted">{$t(statusLabel(session.status))}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}

    {#if running.length}
      <h2>{$t('Working now')} <span class="count">{running.length}</span></h2>
      <ul class="rows">
        {#each running as session (session.id)}
          <li>
            <button type="button" onclick={() => void store.openSession(session.id)}>
              <HarnessMark kind={session.harness} />
              <span class="rows__title">{session.title}</span>
              <StatusDot status="running" />
              <span class="muted">{harnessMeta(session.harness).label}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>

<style>
  .inbox {
    height: 100%;
    overflow-y: auto;
  }
  .page-head,
  .content {
    width: min(760px, calc(100% - 48px));
    margin: 0 auto;
  }
  .page-head {
    padding: var(--piui-space-8) 0 var(--piui-space-4);
  }
  h1 {
    margin: 0;
    font-size: var(--piui-text-2xl);
    font-weight: var(--piui-weight-semibold);
  }
  .page-head p {
    margin: 4px 0 0;
    color: var(--piui-text-muted);
  }
  h2 {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    margin: var(--piui-space-6) 0 var(--piui-space-2);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .count {
    padding: 0 6px;
    border-radius: var(--piui-radius-full);
    background: var(--piui-surface-2);
    color: var(--piui-text);
    font-size: var(--piui-text-xs);
    letter-spacing: 0;
  }
  .list {
    display: grid;
    gap: var(--piui-space-3);
  }
  .rows {
    display: grid;
    gap: 1px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .rows button {
    display: flex;
    align-items: center;
    gap: var(--piui-space-3);
    width: 100%;
    height: 38px;
    padding: 0 var(--piui-space-2);
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text);
    text-align: left;
  }
  .rows button:hover {
    background: var(--piui-hover);
  }
  .rows__title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .muted {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
</style>
