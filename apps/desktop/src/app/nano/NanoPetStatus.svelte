<script lang="ts">
  import { untrack } from 'svelte';
  import type { SessionStatus } from '../../../../../contracts/workspace-v15';
  import NanoPet from './NanoPet.svelte';
  import { NANO_PET_DONE_MS, petStateFor, turnFinished, type PetBlock } from './nanoPet';
  import { nanoPetPreference } from './nanoPetPreference.svelte';

  interface Props {
    /** Status of the Nano chat. */
    status: SessionStatus;
    /** Pending approval requests of the chat. */
    approvals: number;
    blocks: readonly PetBlock[];
    size?: number;
  }
  let { status, approvals, blocks, size = 32 }: Props = $props();

  // A finished turn cheers for a moment, then the pet rests again.
  let cheering = $state(false);
  let previous: SessionStatus | undefined;
  $effect(() => {
    const next = status;
    const finished = turnFinished(untrack(() => previous), next);
    previous = next;
    if (!finished) {
      if (next !== 'idle') cheering = false;
      return;
    }
    cheering = true;
    const timer = setTimeout(() => (cheering = false), NANO_PET_DONE_MS);
    return () => clearTimeout(timer);
  });

  const petState = $derived(petStateFor({ status, approvals, blocks, justFinished: cheering }));
</script>

{#if nanoPetPreference.enabled}
  <NanoPet state={petState} {size} />
{/if}
