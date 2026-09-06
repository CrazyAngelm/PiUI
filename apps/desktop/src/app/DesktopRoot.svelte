<script lang="ts">
  import WorkspaceShell from '../features/workspace/WorkspaceShell.svelte';

  // The classic entry is retained for explicit backwards-compatibility checks.
  // It does not bypass host permissions or enable any test-only runtime.
  const classic = new URLSearchParams(window.location.search).get('view') === 'classic';
</script>

{#if classic}
  {#await import('./App.svelte')}
    <p role="status">Loading classic view…</p>
  {:then legacy}
    <legacy.default />
  {:catch}
    <p role="alert">The classic view could not be loaded. <a href="/">Open sessions</a></p>
  {/await}
{:else}
  <WorkspaceShell />
{/if}
