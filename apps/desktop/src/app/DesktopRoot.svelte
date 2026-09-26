<script lang="ts">
  import { t } from '../features/locale/language';
  import AppShell from './shell/AppShell.svelte';

  // `?view=legacy` keeps the previous workspace shell reachable while the new
  // shell reaches parity; `?view=classic` is the older compatibility entry.
  // Neither bypasses host permissions or enables a test-only runtime.
  const view = new URLSearchParams(window.location.search).get('view');
  // The primitive gallery is a development-only UI Lab page.
  const gallery = view === 'gallery' && import.meta.env.DEV;
</script>

{#if gallery}
  {#await import('../lab/Gallery.svelte') then page}
    <page.default />
  {/await}
{:else if view === 'legacy'}
  {#await import('../features/workspace/WorkspaceShell.svelte') then legacy}
    <legacy.default />
  {/await}
{:else if view === 'classic'}
  {#await import('./App.svelte')}
    <p role="status">{$t("Loading classic view…")}</p>
  {:then legacy}
    <legacy.default />
  {:catch}
    <p role="alert">{$t("The classic view could not be loaded.")} <a href="/">{$t("Open sessions")}</a></p>
  {/await}
{:else}
  <AppShell />
{/if}
