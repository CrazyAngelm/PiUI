<script lang="ts">
  import AppShell from './shell/AppShell.svelte';

  // The primitive gallery is a development-only UI Lab page.
  const gallery = new URLSearchParams(window.location.search).get('view') === 'gallery' && import.meta.env.DEV;
</script>

{#if gallery}
  {#await import('../lab/Gallery.svelte') then page}
    <page.default />
  {/await}
{:else}
  <AppShell />
{/if}
