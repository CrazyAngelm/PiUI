<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../../features/locale/language';
  import type { NanoRemoteDecisionV1, NanoRemotePairingV1 } from '../../host-api/nanoRemoteClient';
  import { Button, Dialog } from '../../lib/ui';
  import { nanoRemote as sharedRemote, type NanoRemote } from './nanoRemote.svelte';

  interface Props {
    /** The browser waiting for a decision; the shell mounts this dialog only while there is one. */
    pending: NanoRemotePairingV1;
    /** Test seam; the shell uses the application's remote access state. */
    remote?: NanoRemote;
  }
  let { pending, remote = sharedRemote }: Props = $props();

  let deny = $state<HTMLButtonElement | null>(null);
  const busy = $derived(remote.action !== undefined);
  // "908621" reads as two groups on screen and digit by digit for a screen reader.
  const grouped = $derived(`${pending.code.slice(0, 3)} ${pending.code.slice(3)}`);
  const spoken = $derived(pending.code.split('').join(' '));

  const decide = (decision: NanoRemoteDecisionV1): void => {
    if (!busy) void remote.decide(pending.requestId, decision);
  };

  // The safe answer is the first and the focused one; a stray Enter or Escape refuses.
  onMount(() => {
    const frame = requestAnimationFrame(() => deny?.focus());
    return () => cancelAnimationFrame(frame);
  });

  // In the capture phase: the dialog's own Escape handler (which ignores it, as
  // this dialog is not dismissible) runs later and marks the event as handled.
  function keydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    decide('deny');
  }
</script>

<svelte:window onkeydowncapture={keydown} />

<Dialog open title={$t('Allow this browser to control Nano Desktop?')} size="sm" dismissible={false}>
  <div class="pairing">
    <p class="browser">{pending.label}</p>
    <p class="code" role="img" aria-label={$t('Code {0}', [spoken])}>{grouped}</p>
    <p class="hint">{$t('Check that the same code is shown in Nano Web. If you did not start this, choose Deny.')}</p>
    <p class="hint">{$t('This browser can read your projects, chats, boards and pipelines, send messages, answer approvals and edit and run supported pipelines on this computer.')}</p>
    {#if remote.error}<p class="error" role="alert">{$t(remote.error)}</p>{/if}
  </div>
  {#snippet footer()}
    <Button bind:ref={deny} onclick={() => decide('deny')} disabled={busy}>{$t('Deny')}</Button>
    <Button variant="primary" onclick={() => decide('once')} disabled={busy}>{$t('Allow once')}</Button>
    <Button variant="ghost" onclick={() => decide('always')} disabled={busy}>{$t('Always allow this browser')}</Button>
  {/snippet}
</Dialog>

<style>
  .pairing {
    display: grid;
    justify-items: center;
    gap: var(--piui-space-3);
    text-align: center;
  }
  .browser {
    margin: 0;
    font-weight: var(--piui-weight-semibold);
    overflow-wrap: anywhere;
  }
  .code {
    margin: 0;
    padding: var(--piui-space-3) var(--piui-space-5);
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-md);
    background: var(--piui-bg-sunken);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-2xl);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.12em;
  }
  .hint {
    margin: 0;
    color: var(--piui-text-muted);
    line-height: var(--piui-leading-normal);
  }
  .error {
    margin: 0;
    color: var(--piui-danger);
  }
</style>
