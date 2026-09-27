<script lang="ts">
  import { onMount } from 'svelte';
  import GitBranch from '@lucide/svelte/icons/git-branch';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import { t } from '../../features/locale/language';
  import type { ManagedWorktreeV1 } from '../../../../../contracts/workspace-placement-v1';
  import { Badge, Button, EmptyState, Skeleton } from '../../lib/ui';
  import { useWorkspace } from '../shell/context';
  import RemoveOrphanDialog from './RemoveOrphanDialog.svelte';
  import { worktreeRows } from './managedWorktrees';
  import { placementRequest, placements } from './placements.svelte';

  /**
   * Settings → Worktrees: every worktree PiUI created for worktree chats
   * (workspace placement v1.1). A worktree whose chats were all deleted is
   * an orphan and can be removed here, with the same dirty check as the
   * chat's own removal. Chats that still use a worktree open from their row.
   */
  const store = useWorkspace();

  let worktrees = $state.raw<ManagedWorktreeV1[] | undefined>();
  let loading = $state(false);
  let error = $state('');
  let removing = $state.raw<ManagedWorktreeV1 | undefined>();

  const rows = $derived(
    worktreeRows(
      worktrees ?? [],
      store.catalog.sessions.map((session) => ({ id: session.id, title: session.title })),
      store.catalog.workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name })),
    ),
  );
  const orphans = $derived(rows.filter((row) => row.orphan).length);

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      const result = await placementRequest({ type: 'worktrees' });
      if (result.type === 'worktrees') worktrees = result.worktrees;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'The operation could not be completed.';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });

  function removed(): void {
    removing = undefined;
    void placements.refresh();
    void load();
  }
</script>

<div class="title-row">
  <h2>{$t('Worktrees')}</h2>
  <Button size="sm" variant="ghost" onclick={() => void load()} loading={loading && worktrees !== undefined}>
    {#snippet leading()}<RefreshCw />{/snippet}
    {$t('Refresh')}
  </Button>
</div>
<p class="lead">
  {$t('Folders PiUI created for worktree chats. Deleting a chat keeps its worktree; remove one here when no chat uses it any more. Branches are never deleted.')}
</p>
{#if store.safeMode}<p class="note" role="status">{$t('Safe mode: worktrees are listed, but none can be removed.')}</p>{/if}
{#if error}<p class="error" role="alert">{$t(error)}</p>{/if}

{#if worktrees === undefined && loading}
  <Skeleton lines={3} />
{:else if worktrees !== undefined && rows.length === 0}
  <EmptyState size="sm" icon={GitBranch} title={$t('No worktrees')} description={$t('Worktrees you create for new chats appear here.')} />
{:else if worktrees !== undefined}
  {#if orphans > 0}
    <p class="note">{$t('Worktrees without a chat: {0}', [orphans])}</p>
  {/if}
  <ul class="list" aria-label={$t('Worktrees')}>
    {#each rows as row (row.worktree.id)}
      <li>
        <article class="card" aria-labelledby={`worktree-${row.worktree.id}`}>
          <GitBranch size={16} class="icon" />
          <div class="main">
            <div class="title">
              <strong class="mono" id={`worktree-${row.worktree.id}`}>{row.worktree.branch}</strong>
              {#if row.orphan}<Badge tone="warning">{$t('No chat')}</Badge>{/if}
              {#if row.worktree.state === 'missing'}<Badge tone="danger">{$t('Folder missing')}</Badge>{/if}
            </div>
            <small>{row.projectName || $t('Project no longer in PiUI')} · {$t('from commit {0}', [row.worktree.base])}</small>
            <small class="mono path" title={row.worktree.path}>{row.worktree.path}</small>
            {#if row.chats.length}
              <div class="chats">
                {#each row.chats as chat (chat.id)}
                  <Button size="sm" variant="ghost" onclick={() => void store.openSession(chat.id)} aria-label={$t('Open chat {0}', [chat.title])}>
                    {#snippet leading()}<MessageSquare />{/snippet}
                    {chat.title}
                  </Button>
                {/each}
              </div>
            {:else if !row.orphan}
              <small>{$t('Used by a chat PiUI does not list.')}</small>
            {/if}
          </div>
          {#if row.orphan}
            <Button
              size="sm"
              variant="ghost"
              disabled={store.safeMode}
              onclick={() => (removing = row.worktree)}
              aria-label={$t('Remove worktree {0}…', [row.worktree.branch])}
            >
              {$t('Remove…')}
            </Button>
          {/if}
        </article>
      </li>
    {/each}
  </ul>
{/if}

{#if removing}
  <RemoveOrphanDialog worktree={removing} onClose={() => (removing = undefined)} onRemoved={removed} />
{/if}

<style>
  .title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font-size: var(--piui-text-xl);
    font-weight: var(--piui-weight-semibold);
  }
  .lead {
    margin: var(--piui-space-2) 0 var(--piui-space-4);
    color: var(--piui-text-muted);
    line-height: var(--piui-leading-normal);
  }
  .note {
    margin: 0 0 var(--piui-space-3);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .error {
    margin: 0 0 var(--piui-space-3);
    color: var(--piui-danger);
  }
  .list {
    display: grid;
    gap: var(--piui-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .card {
    display: flex;
    align-items: flex-start;
    gap: var(--piui-space-3);
    padding: var(--piui-space-3) var(--piui-space-4);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-bg-raised);
  }
  .card :global(.icon) {
    flex: none;
    margin-top: 2px;
    color: var(--piui-text-muted);
  }
  .main {
    display: grid;
    flex: 1;
    gap: 2px;
    min-width: 0;
  }
  .title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--piui-space-2);
  }
  small {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .mono {
    font-family: var(--piui-font-mono);
  }
  .path {
    overflow: hidden;
    font-size: var(--piui-text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chats {
    display: flex;
    flex-wrap: wrap;
    gap: var(--piui-space-1);
    margin-top: var(--piui-space-1);
  }
</style>
