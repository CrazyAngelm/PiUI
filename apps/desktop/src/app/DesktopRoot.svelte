<script lang="ts">
  import { t } from '../features/locale/language';
  import WorkspaceShell from '../features/workspace/WorkspaceShell.svelte';

  // The classic entry is retained for explicit backwards-compatibility checks.
  // It does not bypass host permissions or enable any test-only runtime.
  const classic = new URLSearchParams(window.location.search).get('view') === 'classic';
</script>

{#if classic}
  {#await import('./App.svelte')}
    <p role="status">{$t("Loading classic view…")}</p>
  {:then legacy}
    <legacy.default />
  {:catch}
    <p role="alert">{$t("The classic view could not be loaded.")} <a href="/">{$t("Open sessions")}</a></p>
  {/await}
{:else}
  <WorkspaceShell />
{/if}
