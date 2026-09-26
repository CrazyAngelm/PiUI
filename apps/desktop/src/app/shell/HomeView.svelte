<script lang="ts">
  import { parseTimestamp } from '../../host-api/projectsClient';
  import Workflow from '@lucide/svelte/icons/workflow';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import { t, language } from '../../features/locale/language';
  import type { WorkspaceSummary } from '../../../../../contracts/workspace-v15';
  import { StatusDot } from '../../lib/ui';
  import { relativeTime } from '../format';
  import HarnessMark from './HarnessMark.svelte';
  import NewChatComposer from './NewChatComposer.svelte';
  import { useWorkspace } from './context';

  interface Props {
    onTrust: (workspace: WorkspaceSummary) => void;
  }
  let { onTrust }: Props = $props();
  const store = useWorkspace();

  const recent = $derived(
    [...store.catalog.sessions]
      .filter((session) => !session.runId)
      .sort((left, right) => (parseTimestamp(right.updatedAt) || 0) - (parseTimestamp(left.updatedAt) || 0))
      .slice(0, 5),
  );
  const workspaceNames = $derived(
    new Map(store.catalog.workspaces.map((item) => [item.id, item.personal ? $t('Personal chats') : item.name])),
  );
  const noHarness = $derived(!store.catalogLoading && !store.catalog.harnesses.some((item) => item.status === 'available'));
</script>

<section class="home" aria-labelledby="home-title">
  <div class="home__inner">
    <div class="hero">
      <span class="hero__mark" aria-hidden="true">π</span>
      <h1 id="home-title">{$t('What should we work on?')}</h1>
      {#if store.safeMode}
        <p class="hero__hint">{$t('Safe mode is on: history is readable, agents are not started.')}</p>
      {:else if noHarness}
        <p class="hero__hint">
          {$t('No agent harness is ready yet.')}
          <button type="button" class="link" onclick={() => store.navigate({ name: 'settings', section: 'harnesses' })}>{$t('Set up harnesses')}</button>
        </p>
      {/if}
    </div>

    <NewChatComposer {onTrust} />

    <div class="shortcuts">
      <button type="button" class="card" onclick={() => store.navigate({ name: 'pipelines', section: 'systems' })}>
        <Workflow size={16} />
        <span>
          <strong>{$t('Build a pipeline')}</strong>
          <small>{$t('Connect agents, checks and loops on a canvas')}</small>
        </span>
      </button>
      <button type="button" class="card" onclick={() => store.navigate({ name: 'pipelines', section: 'runs' })}>
        <MessageSquare size={16} />
        <span>
          <strong>{$t('Review runs')}</strong>
          <small>{$t('See what your agents did and what needs you')}</small>
        </span>
      </button>
    </div>

    {#if recent.length}
      <div class="recent">
        <h2>{$t('Recent chats')}</h2>
        <ul>
          {#each recent as session (session.id)}
            <li>
              <button type="button" onclick={() => void store.openSession(session.id)}>
                <HarnessMark kind={session.harness} size={18} />
                <span class="recent__title">{session.title}</span>
                <span class="recent__project">{workspaceNames.get(session.workspaceId) ?? ''}</span>
                {#if ['starting', 'running', 'stopping'].includes(session.status)}
                  <StatusDot status="running" label={$t('Running')} />
                {:else}
                  <span class="recent__time">{relativeTime(session.updatedAt, $language)}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
</section>

<style>
  .home {
    height: 100%;
    overflow-y: auto;
  }
  .home__inner {
    width: min(760px, calc(100% - 48px));
    margin: 0 auto;
    padding: clamp(40px, 14vh, 140px) 0 var(--piui-space-12);
  }
  .hero {
    display: grid;
    justify-items: center;
    gap: var(--piui-space-3);
    margin-bottom: var(--piui-space-7);
    text-align: center;
  }
  .hero__mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: 12px;
    background: var(--piui-surface-1);
    color: var(--piui-accent);
    font-size: 22px;
  }
  h1 {
    margin: 0;
    font-size: var(--piui-text-3xl);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: -0.02em;
  }
  .hero__hint {
    margin: 0;
    color: var(--piui-text-muted);
  }
  .shortcuts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: var(--piui-space-2);
    margin-top: var(--piui-space-4);
  }
  .card {
    display: flex;
    align-items: flex-start;
    gap: var(--piui-space-3);
    padding: var(--piui-space-3) var(--piui-space-4);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: transparent;
    color: var(--piui-text-muted);
    text-align: left;
    transition:
      background-color var(--piui-duration-fast) var(--piui-ease-out),
      border-color var(--piui-duration-fast) var(--piui-ease-out);
  }
  .card:hover {
    border-color: var(--piui-border);
    background: var(--piui-hover);
  }
  .card :global(svg) {
    margin-top: 2px;
    color: var(--piui-accent);
  }
  .card span {
    display: grid;
    gap: 2px;
  }
  .card strong {
    color: var(--piui-text);
    font-weight: var(--piui-weight-medium);
  }
  .card small {
    font-size: var(--piui-text-sm);
  }
  .recent {
    margin-top: var(--piui-space-8);
  }
  .recent h2 {
    margin: 0 0 var(--piui-space-2);
    padding: 0 var(--piui-space-2);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .recent ul {
    display: grid;
    gap: 1px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .recent button {
    display: flex;
    align-items: center;
    gap: var(--piui-space-3);
    width: 100%;
    height: 36px;
    padding: 0 var(--piui-space-2);
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text);
    text-align: left;
  }
  .recent button:hover {
    background: var(--piui-hover);
  }
  .recent__title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .recent__project,
  .recent__time {
    flex: none;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .recent__time {
    min-width: 44px;
    color: var(--piui-text-faint);
    text-align: right;
  }
  .link {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--piui-accent);
  }
</style>
