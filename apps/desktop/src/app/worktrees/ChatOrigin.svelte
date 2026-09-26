<script lang="ts">
  import Copy from '@lucide/svelte/icons/copy';
  import GitBranch from '@lucide/svelte/icons/git-branch';
  import GitCompare from '@lucide/svelte/icons/git-compare';
  import Terminal from '@lucide/svelte/icons/square-terminal';
  import { t } from '../../features/locale/language';
  import { Badge, Button, IconButton, toasts } from '../../lib/ui';
  import { useWorkspace } from '../shell/context';
  import { placements } from './placements.svelte';

  /** Chat details: the worktree a chat runs in and where the chat came from. */
  interface Props {
    sessionId: string;
    onReview?: () => void;
  }
  let { sessionId, onReview }: Props = $props();
  const store = useWorkspace();
  let removing = $state(false);
  const loadRemoveDialog = () => import('./RemoveWorktreeDialog.svelte');

  const placement = $derived(placements.get(sessionId));
  const worktree = $derived(placement?.worktree);
  const source = $derived(
    placement?.continuedFrom === undefined ? undefined : store.catalog.sessions.find((session) => session.id === placement.continuedFrom),
  );

  async function copyBranch(): Promise<void> {
    if (!worktree) return;
    try {
      await navigator.clipboard.writeText(worktree.branch);
      toasts.success($t('Branch name copied'), worktree.branch);
    } catch {
      toasts.error($t('Could not copy the branch name'));
    }
  }
</script>

{#if worktree}
  <section class="origin" aria-labelledby="worktree-title-{sessionId}">
    <h3 id="worktree-title-{sessionId}"><GitBranch size={13} /> {$t('Worktree')}</h3>
    <dl>
      <div>
        <dt>{$t('Branch')}</dt>
        <dd class="row">
          <code>{worktree.branch}</code>
          <IconButton label={$t('Copy branch name')} size="sm" onclick={() => void copyBranch()}><Copy /></IconButton>
        </dd>
      </div>
      <div>
        <dt>{$t('Folder')}</dt>
        <dd><code class="path">{worktree.path}</code></dd>
      </div>
      <div>
        <dt>{$t('Started from')}</dt>
        <dd><code>{worktree.base}</code></dd>
      </div>
    </dl>
    {#if worktree.state === 'removed'}
      <p class="note"><Badge>{$t('Removed')}</Badge> {$t('The worktree was removed. The branch stays; this chat stays readable.')}</p>
    {:else if worktree.state === 'missing'}
      <p class="note note--warn"><Badge tone="warning">{$t('Missing')}</Badge> {$t('The worktree folder is missing. Remove the worktree to clean up.')}</p>
    {/if}
    <div class="actions">
      {#if onReview && worktree.state === 'ready'}
        <Button size="sm" onclick={onReview}>
          {#snippet leading()}<GitCompare />{/snippet}
          {$t('Review changes')}
        </Button>
      {/if}
      {#if worktree.state !== 'removed'}
        <Button size="sm" variant="ghost" disabled={store.safeMode} onclick={() => (removing = true)}>{$t('Remove worktree…')}</Button>
      {/if}
    </div>
  </section>
  {#if removing}
    {#await loadRemoveDialog() then module}
      <module.default {sessionId} branch={worktree.branch} path={worktree.path} onClose={() => (removing = false)} />
    {/await}
  {/if}
{/if}

{#if placement?.continuedFrom}
  <section class="origin">
    <h3>{$t('Continued from')}</h3>
    {#if source}
      <button type="button" class="link" onclick={() => void store.openSession(source.id)}>{source.title}</button>
      <p class="note">{$t('This chat continues that one. Its history was not copied or converted.')}</p>
    {:else}
      <p class="note">{$t('A chat that is no longer in PiUI.')}</p>
    {/if}
  </section>
{/if}

{#if placement?.adopted}
  <section class="origin">
    <p class="note"><Terminal size={13} /> {$t('Started in the Pi terminal app. PiUI continues the same session file.')}</p>
  </section>
{/if}

<style>
  .origin {
    display: grid;
    gap: var(--piui-space-2);
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-semibold);
  }
  dl {
    display: grid;
    gap: var(--piui-space-2);
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
  }
  dd {
    margin: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--piui-space-1);
  }
  code {
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-sm);
  }
  .path {
    word-break: break-all;
    color: var(--piui-text-muted);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--piui-space-2);
  }
  .note {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .note--warn {
    color: var(--piui-warning-text);
  }
  .link {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--piui-accent);
    text-align: left;
  }
</style>
