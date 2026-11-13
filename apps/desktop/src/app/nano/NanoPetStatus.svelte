<script lang="ts">
  import { untrack } from 'svelte';
  import type { SessionStatus } from '../../../../../contracts/workspace-v15';
  import NanoPet from './NanoPet.svelte';
  import { petStateFor, turnFinished, type PetBlock } from './nanoPet';
  import { nanoPetPreference } from './nanoPetPreference.svelte';
  import { nanoAccount } from './nanoAccount.svelte';
  import { nanoAvatar } from './nanoAvatar.svelte';
  import { clipDuration } from './avatarAnimation';

  interface Props {
    /** Status of the Nano chat. */
    status: SessionStatus;
    /** Pending approval requests of the chat. */
    approvals: number;
    blocks: readonly PetBlock[];
    size?: number;
    safeMode: boolean;
  }
  let { status, approvals, blocks, size = 32, safeMode }: Props = $props();

  const enabled = $derived(!safeMode && nanoAccount.canUseAvatars && nanoPetPreference.enabled);
  $effect(() => {
    if (enabled) return nanoAvatar.acquire();
  });

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
    const done = untrack(() => nanoAvatar.ready?.manifest.clips.done);
    if (!done) { cheering = false; return; }
    const timer = setTimeout(() => (cheering = false), clipDuration(done) * (done.repeat ?? 1));
    return () => clearTimeout(timer);
  });

  const petState = $derived(petStateFor({ status, approvals, blocks, justFinished: cheering }));
</script>

{#if enabled && nanoAvatar.ready}
  <NanoPet avatar={nanoAvatar.ready} state={petState} {size} />
{/if}
