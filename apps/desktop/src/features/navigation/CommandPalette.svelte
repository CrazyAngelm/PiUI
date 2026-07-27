<script lang="ts">
  import { tick } from 'svelte';
  import type { PiUiCommandContribution, RuntimeCommand, SessionSummary } from '../../host-api/types';
  import { applyPiUiCommandContributions, filterRuntimeCommands, runtimeCommandKey, runtimeCommandProvenance } from '../runtime/runtimeCommands';

  export let open = false;
  export let query = '';
  export let results: SessionSummary[] = [];
  export let busy = false;
  export let error: string | undefined;
  export let onClose: () => void;
  export let onQuery: (query: string) => void;
  export let onOpenResult: (result: SessionSummary) => void;
  export let commands: RuntimeCommand[] = [];
  export let piUiCommands: PiUiCommandContribution[] = [];
  export let commandSelectionDisabled = false;
  export let onUseCommand: (command: RuntimeCommand) => void = () => {};

  let dialog: HTMLDialogElement | undefined;

  $: contributedCommands = applyPiUiCommandContributions(commands, piUiCommands);
  $: visibleCommands = filterRuntimeCommands(contributedCommands, query, 8);
  $: if (open) void focusSearch();

  async function focusSearch(): Promise<void> {
    await tick();
    dialog?.querySelector<HTMLInputElement>('#local-search')?.focus();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || dialog === undefined) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    if (focusable.length === 0) return;
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.shiftKey
      ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
      : (currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
    event.preventDefault();
    focusable[nextIndex]?.focus();
  }

  function closeOnBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) onClose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div class="backdrop" role="presentation" onclick={closeOnBackdrop}>
    <dialog bind:this={dialog} open class="dialog" aria-modal="true" aria-labelledby="search-title">
      <div class="heading">
        <div>
          <p class="eyebrow">Navigation and Pi commands</p>
          <h2 id="search-title">Go to</h2>
        </div>
        <kbd>Esc</kbd>
      </div>
      <label class="visually-hidden" for="local-search">Search Pi commands and local sessions</label>
      <input
        id="local-search"
        bind:value={query}
        oninput={() => onQuery(query)}
        autocomplete="off"
        placeholder="Search commands and sessions…"
      />
      <p class="helper">
        {commandSelectionDisabled
          ? 'Clear the current composer draft before preparing a Pi command. Session search remains available.'
          : 'Commands come from the active Pi runtime. Session search stays in the local index.'}
      </p>

      {#if visibleCommands.length > 0}
        <section class="command-results" aria-label="Pi commands">
          <p class="result-section-label">Pi commands</p>
          {#each visibleCommands as command (runtimeCommandKey(command))}
            <button class="command-result" type="button" disabled={commandSelectionDisabled} onclick={() => onUseCommand(command)}>
              <span class="command-name">/{command.name}</span>
              {#if command.description}<span class="command-description">{command.description}</span>{/if}
              <span class="command-source">{runtimeCommandProvenance(command)}</span>
            </button>
          {/each}
        </section>
      {/if}

      <section class="results" aria-live="polite" aria-label="Session search results">
        {#if busy}
          <p class="status">Searching local history…</p>
        {:else if error}
          <p class="error" role="alert">{error}</p>
        {:else if query.trim().length === 0}
          <p class="status">Type to search indexed local sessions.</p>
        {:else if results.length === 0}
          <p class="status">No matching indexed sessions.</p>
        {:else}
          {#each results as result (result.id)}
            <button class="result" type="button" onclick={() => onOpenResult(result)}>
              <span class="result-title">{result.title}</span>
              {#if result.preview}<span class="result-preview">{result.preview}</span>{/if}
            </button>
          {/each}
        {/if}
      </section>
    </dialog>
  </div>
{/if}

<style>
  .backdrop { position: fixed; inset: 0; z-index: 30; display: grid; place-items: start center; padding: min(14vh, 120px) var(--piui-space-4) var(--piui-space-4); background: rgba(12, 15, 12, .72); }
  .dialog { width: min(100%, 660px); max-height: min(72vh, 640px); overflow: auto; border: 1px solid var(--piui-border); border-radius: var(--piui-radius-lg); background: var(--piui-bg-raised); padding: var(--piui-space-5); box-shadow: 0 24px 72px rgba(0, 0, 0, .3), inset 0 1px 0 rgba(255, 255, 255, .04); }
  .heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--piui-space-3); }.eyebrow { margin: 0 0 var(--piui-space-1); color: var(--piui-accent); font-size: 10px; font-weight: 720; letter-spacing: .1em; text-transform: uppercase; } h2 { margin: 0; font-size: 20px; letter-spacing: -.025em; } kbd { padding: 2px 5px; border: 1px solid var(--piui-border); border-radius: 3px; color: var(--piui-text-faint); font-family: var(--piui-font-mono); font-size: 10px; }
  input { width: 100%; min-height: 42px; margin-top: var(--piui-space-4); padding: 0 var(--piui-space-3); border: 1px solid var(--piui-border); border-radius: var(--piui-radius-sm); background: var(--piui-surface-1); color: var(--piui-text); }.helper { margin: var(--piui-space-2) 0 0; color: var(--piui-text-muted); font-size: 11px; line-height: 1.45; }
  .command-results { display: grid; margin-top: var(--piui-space-4); padding-top: var(--piui-space-3); border-top: 1px solid var(--piui-border-subtle); }
  .result-section-label { margin: 0 0 6px; color: var(--piui-text-faint); font-size: 9px; font-weight: 760; letter-spacing: .09em; text-transform: uppercase; }
  .command-result { display: grid; grid-template-columns: minmax(130px, .8fr) minmax(0, 1.2fr) auto; align-items: center; gap: var(--piui-space-3); min-height: 40px; padding: 7px var(--piui-space-2); border-top: 1px solid var(--piui-border-subtle); background: transparent; color: var(--piui-text); text-align: left; }
  .command-result:hover:not(:disabled), .command-result:focus-visible { background: var(--piui-surface-1); }
  .command-result:disabled { cursor: not-allowed; opacity: .48; }
  .command-name { overflow: hidden; font-family: var(--piui-font-mono); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .command-description { overflow: hidden; color: var(--piui-text-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .command-source { color: var(--piui-text-faint); font-size: 9px; text-transform: uppercase; }
  .results { display: grid; gap: 3px; margin-top: var(--piui-space-4); padding-top: var(--piui-space-3); border-top: 1px solid var(--piui-border-subtle); }.status, .error { margin: var(--piui-space-3) 0; color: var(--piui-text-muted); font-size: 12px; }.error { color: var(--piui-danger); }.result { display: grid; gap: 2px; width: 100%; padding: var(--piui-space-3); border-radius: var(--piui-radius-sm); background: transparent; color: var(--piui-text); text-align: left; }.result:hover, .result:focus-visible { background: var(--piui-surface-1); }.result-title { overflow: hidden; font-size: 13px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }.result-preview { display: -webkit-box; overflow: hidden; margin-top: 2px; color: var(--piui-text-muted); font-size: 11px; line-height: 1.4; -webkit-box-orient: vertical; line-clamp: 2; -webkit-line-clamp: 2; }
  @media (max-width: 600px) { .command-result { grid-template-columns: minmax(110px, .8fr) minmax(0, 1.2fr); }.command-source { display: none; } }
</style>
