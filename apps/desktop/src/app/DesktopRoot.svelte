<script lang="ts">
  import WorkspaceShell from '../features/workspace/WorkspaceShell.svelte';

  // The classic entry is retained for explicit backwards-compatibility checks.
  // It does not bypass host permissions or enable any test-only runtime.
  const classic = new URLSearchParams(window.location.search).get('view') === 'classic';
  let history = $state(false);
</script>

{#if classic}
  {#await import('./App.svelte')}
    <p role="status">Loading classic view…</p>
  {:then legacy}
    <legacy.default />
  {:catch}
    <p role="alert">The classic view could not be loaded. <a href="/">Open sessions</a></p>
  {/await}
{:else if history}
  <div class="history-page">
    <nav class="history-navigation" aria-label="Indexed history navigation">
      <button type="button" onclick={() => history = false}>← Back to sessions</button>
      <span>Indexed Pi and Prime history <span class="read-only">· Read only</span></span>
    </nav>
    <div class="legacy-content">
      {#await import('./App.svelte')}
        <p role="status">Loading indexed history…</p>
      {:then legacy}
        <legacy.default historyOnly={true} onNewWorkspaceChat={() => history = false} />
      {:catch}
        <p role="alert">Indexed history could not be loaded. Return to sessions and try again.</p>
      {/await}
    </div>
  </div>
{:else}
  <WorkspaceShell onOpenLegacyHistory={() => history = true} />
{/if}

<style>
  .history-page { height: 100dvh; display: flex; flex-direction: column; min-height: 0; }
  .history-navigation { display: flex; flex-wrap: wrap; align-items: center; gap: var(--piui-space-4); padding: var(--piui-space-2) var(--piui-space-4); border-bottom: 1px solid var(--piui-border-subtle); background: var(--piui-bg-raised); font-size: 13px; }
  .history-navigation button { padding: var(--piui-space-2); border-radius: var(--piui-radius-sm); color: var(--piui-text); background: var(--piui-surface-1); }
  .history-navigation button:hover { background: var(--piui-surface-2); }
  .read-only { color: var(--piui-text-muted); }
  .legacy-content { flex: 1; min-height: 0; overflow: hidden; }
  .legacy-content :global(.app-shell), .legacy-content :global(.workspace) { height: 100%; }
</style>
