<script lang="ts">
  import { onMount } from 'svelte';
  import { nanoRemote as sharedRemote, type NanoRemote } from './nanoRemote.svelte';

  interface Props {
    /** Test seam; the shell uses the application's remote access state. */
    remote?: NanoRemote;
  }
  let { remote = sharedRemote }: Props = $props();

  // The host status is local: one read after first paint, then its events.
  onMount(() => {
    void remote.start();
  });

  const pending = $derived(remote.pending);
</script>

<!-- A browser waiting to be allowed to control this computer; the prompt loads when the first request arrives. -->
{#if pending}
  {@const waiting = pending}
  {#await import('./RemotePairingDialog.svelte') then module}
    {#key waiting.requestId}
      <module.default pending={waiting} {remote} />
    {/key}
  {/await}
{/if}
