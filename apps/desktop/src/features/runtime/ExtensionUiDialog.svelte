<script lang="ts">
  import { tick } from 'svelte';
  import type { ExtensionDialogRequest, ExtensionUiResponse } from '../../host-api/types';

  export let request: ExtensionDialogRequest;
  export let busy = false;
  export let error: string | undefined = undefined;
  export let onRespond: (response: ExtensionUiResponse) => void;

  let dialog: HTMLDialogElement | undefined;
  let inputValue = '';
  let observedRequestId = '';

  $: initializeRequest(request);

  function initializeRequest(next: ExtensionDialogRequest): void {
    if (observedRequestId === next.id) return;
    observedRequestId = next.id;
    inputValue = next.kind === 'editor' ? next.prefill ?? '' : '';
    void focusInitialControl();
  }

  async function focusInitialControl(): Promise<void> {
    await tick();
    const target = request.kind === 'select'
      ? dialog?.querySelector<HTMLElement>('[data-extension-option]')
      : dialog?.querySelector<HTMLElement>('input, textarea, [data-primary-action]');
    target?.focus();
  }

  function respond(response: ExtensionUiResponse): void {
    if (busy) return;
    onRespond(response);
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (request.kind === 'input' || request.kind === 'editor') {
      respond({ kind: 'submitted', value: inputValue });
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      respond({ kind: 'cancelled' });
      return;
    }
    if (event.key !== 'Tab' || dialog === undefined) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1) as HTMLElement;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

<div class="extension-dialog-backdrop" role="presentation">
  <dialog
    bind:this={dialog}
    open
    class="extension-dialog"
    aria-modal="true"
    aria-labelledby="extension-dialog-title"
    aria-describedby={request.kind === 'confirm' ? 'extension-dialog-message' : undefined}
    onkeydown={handleKeydown}
  >
    <header>
      <p class="extension-source">Pi extension</p>
      <h2 id="extension-dialog-title">{request.title}</h2>
      {#if request.timeoutMs !== undefined}
        <p class="extension-timeout">This request closes automatically.</p>
      {/if}
    </header>

    {#if request.kind === 'select'}
      <div class="extension-options" role="list" aria-label={request.title}>
        {#each request.options as option (option.id)}
          <button
            type="button"
            class="extension-option"
            data-extension-option
            disabled={busy}
            onclick={() => respond({ kind: 'selected', optionId: option.id })}
          >
            <span>{option.label}</span>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 6 6-6 6"/></svg>
          </button>
        {/each}
      </div>
      <div class="extension-dialog-actions">
        <button type="button" class="quiet" disabled={busy} onclick={() => respond({ kind: 'cancelled' })}>Cancel</button>
      </div>
    {:else if request.kind === 'confirm'}
      <p id="extension-dialog-message" class="extension-message">{request.message}</p>
      <div class="extension-dialog-actions">
        <button type="button" class="quiet" disabled={busy} onclick={() => respond({ kind: 'confirmed', value: false })}>No</button>
        <button type="button" class="primary" data-primary-action disabled={busy} onclick={() => respond({ kind: 'confirmed', value: true })}>{busy ? 'Responding…' : 'Yes'}</button>
      </div>
    {:else}
      <form onsubmit={submit}>
        {#if request.kind === 'input'}
          <label for="extension-input">Response</label>
          <input id="extension-input" bind:value={inputValue} placeholder={request.placeholder} disabled={busy} autocomplete="off" />
        {:else}
          <label for="extension-editor">Response</label>
          <textarea id="extension-editor" bind:value={inputValue} rows="10" disabled={busy}></textarea>
        {/if}
        <div class="extension-dialog-actions">
          <button type="button" class="quiet" disabled={busy} onclick={() => respond({ kind: 'cancelled' })}>Cancel</button>
          <button type="submit" class="primary" data-primary-action disabled={busy}>{busy ? 'Submitting…' : 'Submit'}</button>
        </div>
      </form>
    {/if}

    {#if error}<p class="extension-error" role="alert">{error}</p>{/if}
  </dialog>
</div>

<style>
  .extension-dialog-backdrop { position: fixed; inset: 0; z-index: 30; display: grid; place-items: center; padding: var(--piui-space-4); background: rgba(12, 15, 12, .76); }
  .extension-dialog { width: min(100%, 560px); max-height: min(82dvh, 720px); overflow: auto; border: 1px solid var(--piui-border); border-radius: var(--piui-radius-lg); background: var(--piui-bg-raised); padding: clamp(22px, 4vw, 34px); color: var(--piui-text); box-shadow: 0 24px 72px rgba(0, 0, 0, .34), inset 0 1px 0 rgba(255, 255, 255, .04); }
  header { margin-bottom: var(--piui-space-5); }
  .extension-source { margin: 0 0 var(--piui-space-2); color: var(--piui-accent); font-size: 10px; font-weight: 760; letter-spacing: .12em; text-transform: uppercase; }
  h2 { margin: 0; font-size: clamp(21px, 3vw, 28px); letter-spacing: -.025em; line-height: 1.16; overflow-wrap: anywhere; }
  .extension-timeout { margin: var(--piui-space-2) 0 0; color: var(--piui-text-faint); font-size: 11px; }
  .extension-message { margin: 0 0 var(--piui-space-5); color: var(--piui-text-muted); line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
  .extension-options { display: grid; max-height: min(50dvh, 420px); overflow: auto; border-top: 1px solid var(--piui-border); }
  .extension-option { display: grid; grid-template-columns: minmax(0, 1fr) 18px; align-items: center; gap: var(--piui-space-3); width: 100%; min-height: 46px; padding: 10px 4px; border-bottom: 1px solid var(--piui-border); background: transparent; color: var(--piui-text); text-align: left; }
  .extension-option:hover:not(:disabled), .extension-option:focus-visible { background: var(--piui-surface-2); }
  .extension-option span { overflow-wrap: anywhere; }
  .extension-option svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; }
  form { display: grid; gap: var(--piui-space-2); }
  label { color: var(--piui-text-muted); font-size: 11px; font-weight: 720; }
  input, textarea { width: 100%; border: 1px solid var(--piui-border); border-radius: var(--piui-radius-sm); background: var(--piui-surface-1); color: var(--piui-text); font: inherit; line-height: 1.5; outline: 0; }
  input { min-height: 42px; padding: 0 12px; }
  textarea { min-height: 180px; padding: 12px; resize: vertical; font-family: var(--piui-font-mono); font-size: 12px; }
  input:focus, textarea:focus { border-color: color-mix(in srgb, var(--piui-accent) 62%, var(--piui-border)); }
  .extension-dialog-actions { display: flex; justify-content: flex-end; gap: var(--piui-space-2); margin-top: var(--piui-space-5); }
  .extension-dialog-actions button { min-height: 36px; padding: 0 14px; border-radius: 9px; font-size: 12px; font-weight: 720; transition: transform 120ms ease, background 120ms ease; }
  .extension-dialog-actions button:active:not(:disabled) { transform: scale(.98); }
  .quiet { border: 1px solid var(--piui-border); background: transparent; color: var(--piui-text-muted); }
  .primary { border: 0; background: var(--piui-accent); color: var(--piui-accent-ink); }
  button:disabled { opacity: .5; }
  .extension-error { margin: var(--piui-space-3) 0 0; color: var(--piui-danger-text); font-size: 12px; }
  @media (max-width: 600px) { .extension-dialog-backdrop { align-items: end; padding: 10px; }.extension-dialog { width: 100%; max-height: 90dvh; border-radius: 18px; padding: 22px 18px; } }
</style>
