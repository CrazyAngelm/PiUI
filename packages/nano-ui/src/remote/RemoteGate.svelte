<script lang="ts">
  import { gateModel } from './gateModel.svelte';
  import { GATE_WORDS, gateText, groupCode, retryText, spokenCode } from './gateCopy';

  interface Props {
    /** Reloads the page: a new socket, a new handshake. */
    onReconnect: () => void;
  }

  const { onReconnect }: Props = $props();

  const words = $derived(GATE_WORDS[gateModel.language]);
  const text = $derived(gateText(gateModel.view, gateModel.language));
  const view = $derived(gateModel.view);
  const busy = $derived(view.kind === 'connecting');
  let reconnectButton: HTMLButtonElement | undefined = $state();

  // The button is the only thing to do on these screens: keyboard focus goes to it.
  $effect(() => {
    if (text.reconnect) reconnectButton?.focus();
  });
</script>

<main class="gate" aria-busy={busy}>
  <div class="gate__card">
    <div role="status" class="gate__state">
      {#if busy}<span class="gate__spinner" aria-hidden="true"></span>{/if}
      <h1 class="gate__title">{text.title}</h1>
      {#if view.kind === 'approval'}
        <p class="gate__device">{view.deviceName}</p>
      {/if}
      {#if text.detail}
        <p class="gate__detail">{text.detail}</p>
      {/if}
    </div>

    {#if view.kind === 'approval'}
      <p class="gate__code">
        <span class="visually-hidden">{words.code} {spokenCode(view.code)}</span>
        <span aria-hidden="true">{groupCode(view.code)}</span>
      </p>
    {/if}

    {#if gateModel.memoryKey && (view.kind === 'connecting' || view.kind === 'approval')}
      <p class="gate__note">{words.memoryKey}</p>
    {/if}

    {#if text.reconnect}
      {#if gateModel.retryIn !== undefined}
        <p class="gate__detail">{retryText(gateModel.retryIn, gateModel.language)}</p>
      {/if}
      <button type="button" class="gate__button" bind:this={reconnectButton} onclick={onReconnect}>{words.reconnect}</button>
    {/if}
  </div>
</main>
