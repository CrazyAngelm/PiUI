<script lang="ts">
  import { tick } from 'svelte';
  import type { ModelLite } from '../../host-api/types';
  import { filterModelPickerOptions, modelDisplayName, modelIsAvailable, orderModelPickerOptions, providerDisplayName } from './modelPicker';

  export let models: ModelLite[] = [];
  export let currentModel: ModelLite | undefined;
  export let disabled = false;
  export let onSelect: (model: ModelLite) => void | Promise<void> = () => {};

  const MAX_RENDERED_MODELS = 120;

  let root: HTMLDivElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  let open = false;
  let query = '';
  let activeIndex = 0;

  $: displayedModel = currentModel ?? models[0];
  $: currentModelKey = displayedModel === undefined ? '' : modelKey(displayedModel);
  $: currentModelAvailable = modelIsAvailable(models, displayedModel);
  $: orderedModels = orderModelPickerOptions(models, displayedModel);
  $: matchingModels = filterModelPickerOptions(orderedModels, query);
  $: filteredModels = matchingModels.slice(0, MAX_RENDERED_MODELS);
  $: hiddenModelCount = Math.max(0, matchingModels.length - filteredModels.length);
  $: if (activeIndex >= filteredModels.length) activeIndex = Math.max(0, filteredModels.length - 1);

  function modelKey(model: ModelLite): string {
    return `${model.provider}\u0000${model.id}`;
  }

  async function openPicker(): Promise<void> {
    if (disabled || models.length === 0) return;
    query = '';
    const selectedIndex = filterModelPickerOptions(orderedModels, '').findIndex((model) => modelKey(model) === currentModelKey);
    activeIndex = Math.max(0, selectedIndex);
    open = true;
    await tick();
    searchInput?.focus();
    root?.querySelector<HTMLElement>(`#model-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }

  function closePicker(restoreFocus = true): void {
    open = false;
    query = '';
    if (restoreFocus) void tick().then(() => root?.querySelector<HTMLButtonElement>('.model-trigger')?.focus());
  }

  function moveSelection(delta: number): void {
    if (filteredModels.length === 0) return;
    activeIndex = (activeIndex + delta + filteredModels.length) % filteredModels.length;
    void tick().then(() => root?.querySelector<HTMLElement>(`#model-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' }));
  }

  function choose(model: ModelLite): void {
    closePicker();
    void onSelect(model);
  }

  function handleTriggerKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    void openPicker();
  }

  function handleMenuKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      activeIndex = event.key === 'Home' ? 0 : Math.max(0, filteredModels.length - 1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const model = filteredModels[Math.min(activeIndex, Math.max(0, filteredModels.length - 1))];
      if (model !== undefined) choose(model);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closePicker();
    }
  }

  function handleWindowPointerDown(event: PointerEvent): void {
    if (!open || root === undefined || !(event.target instanceof Node) || root.contains(event.target)) return;
    closePicker(false);
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (open && event.key === 'Escape' && !event.defaultPrevented) closePicker();
  }

  function handleFocusOut(event: FocusEvent): void {
    if (!open || root === undefined || !(event.relatedTarget instanceof Node) || root.contains(event.relatedTarget)) return;
    closePicker(false);
  }
</script>

<svelte:window onpointerdown={handleWindowPointerDown} onkeydown={handleWindowKeydown} />

<div class="model-picker" bind:this={root} onfocusout={handleFocusOut}>
  <button
    type="button"
    class="model-trigger"
    aria-label={displayedModel === undefined ? 'Choose model' : `Choose model, current ${modelDisplayName(displayedModel)}${currentModelAvailable ? '' : ', unavailable'}`}
    aria-haspopup="dialog"
    aria-controls={open ? 'model-picker-popup' : undefined}
    aria-expanded={open}
    title={displayedModel === undefined ? 'Choose model' : `${displayedModel.provider}/${displayedModel.id}${currentModelAvailable ? '' : ' — unavailable'}`}
    {disabled}
    onclick={() => open ? closePicker(false) : void openPicker()}
    onkeydown={handleTriggerKeydown}
  >
    <svg class="model-icon" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="4" y="4" width="12" height="12" rx="2" />
      <rect x="8" y="8" width="4" height="4" rx=".5" />
      <path d="M7 2v2m6-2v2M7 16v2m6-2v2M2 7h2m-2 6h2m12-6h2m-2 6h2" />
    </svg>
    <span>{displayedModel === undefined ? 'Select model' : modelDisplayName(displayedModel)}</span>
    {#if displayedModel !== undefined && !currentModelAvailable}<span class="unavailable-mark" aria-hidden="true">!</span>{/if}
    <svg class="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
  </button>

  {#if open}
    <div id="model-picker-popup" class="model-menu" role="dialog" aria-label="Choose a Pi model">
      <label class="search">
        <svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="8" cy="8" r="4.75" /><path d="m11.5 11.5 3 3" /></svg>
        <span class="visually-hidden">Search models</span>
        <input
          bind:this={searchInput}
          bind:value={query}
          type="search"
          placeholder="Find a model…"
          autocomplete="off"
          aria-controls="model-options"
          aria-activedescendant={filteredModels.length > 0 ? `model-option-${activeIndex}` : undefined}
          oninput={() => (activeIndex = 0)}
          onkeydown={handleMenuKeydown}
        />
        {#if query.length > 0}<button type="button" class="clear-search" aria-label="Clear model search" onclick={() => { query = ''; activeIndex = 0; searchInput?.focus(); }}>×</button>{/if}
      </label>

      <div id="model-options" class="model-options" role="listbox" aria-label="Available models">
        {#if filteredModels.length === 0}
          <p class="no-results">No matching models</p>
        {:else}
          {#each filteredModels as model, index (`${modelKey(model)}:${index}`)}
            {#if index === 0 || filteredModels[index - 1]?.provider !== model.provider}
              <p class="provider-label">{providerDisplayName(model.provider)}</p>
            {/if}
            <button
              id={`model-option-${index}`}
              type="button"
              role="option"
              tabindex="-1"
              aria-selected={modelKey(model) === currentModelKey}
              class:active={index === activeIndex}
              class:selected={modelKey(model) === currentModelKey}
              title={`${model.provider}/${model.id}`}
              onmouseenter={() => (activeIndex = index)}
              onclick={() => choose(model)}
            >
              <span class="check" aria-hidden="true">
                {#if modelKey(model) === currentModelKey}<svg viewBox="0 0 16 16"><path d="m3 8 3 3 7-7" /></svg>{/if}
              </span>
              <span class="model-name">{modelDisplayName(model)}</span>
              {#if modelKey(model) === currentModelKey && !currentModelAvailable}<span class="availability">Unavailable</span>{/if}
            </button>
          {/each}
        {/if}
        {#if hiddenModelCount > 0}<p class="result-limit">{hiddenModelCount} more — refine your search</p>{/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .model-picker { position: relative; min-width: 0; }
  .model-trigger { display: flex; align-items: center; gap: 6px; min-width: 0; max-width: 190px; height: 28px; padding: 0 7px; border: 0; border-radius: 8px; background: color-mix(in srgb, var(--piui-text) 6%, transparent); color: var(--piui-text-muted); font-size: 11px; font-weight: 650; text-align: left; transition: background 140ms ease, color 140ms ease; }
  .model-trigger:hover:not(:disabled), .model-trigger[aria-expanded="true"] { background: color-mix(in srgb, var(--piui-text) 10%, transparent); color: var(--piui-text); }
  .model-trigger:focus-visible { outline: 2px solid var(--piui-focus); outline-offset: 2px; }
  .model-trigger:disabled { cursor: not-allowed; opacity: .5; }
  .model-trigger > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .model-trigger > .unavailable-mark { display: grid; width: 14px; height: 14px; flex: 0 0 auto; place-items: center; overflow: visible; border: 1px solid var(--piui-warning-border); border-radius: 50%; color: var(--piui-warning); font-size: 9px; font-weight: 800; }
  .model-icon { width: 13px; height: 13px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.25; opacity: .72; }
  .chevron { width: 12px; height: 12px; flex: 0 0 auto; margin-left: auto; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.6; }
  .model-menu { position: absolute; bottom: calc(100% + 9px); left: 0; z-index: 18; width: min(340px, calc(100vw - 32px)); overflow: hidden; border: 1px solid var(--piui-border); border-radius: 13px; background: var(--piui-bg-raised); color: var(--piui-text); box-shadow: 0 18px 52px rgba(0, 0, 0, .34), inset 0 1px 0 color-mix(in srgb, var(--piui-text) 4%, transparent); }
  .search { display: flex; align-items: center; gap: 8px; margin: 0; padding: 8px 10px; border-bottom: 1px solid var(--piui-border-subtle); background: color-mix(in srgb, var(--piui-surface-1) 78%, var(--piui-bg-raised)); }
  .search > svg { width: 15px; height: 15px; flex: 0 0 auto; fill: none; stroke: var(--piui-text-faint); stroke-linecap: round; stroke-width: 1.5; }
  .search input { width: 100%; min-width: 0; height: 28px; padding: 0; border: 0; outline: 0; background: transparent; color: var(--piui-text); font: inherit; font-size: 12px; }
  .search input::placeholder { color: var(--piui-text-faint); }
  .search input::-webkit-search-cancel-button { display: none; }
  .clear-search { display: grid; width: 24px; height: 24px; flex: 0 0 auto; place-items: center; border: 0; border-radius: 6px; background: transparent; color: var(--piui-text-faint); font-size: 17px; line-height: 1; }
  .clear-search:hover { background: var(--piui-surface-2); color: var(--piui-text); }
  .model-options { max-height: min(330px, 52dvh); overflow-y: auto; overscroll-behavior: contain; padding: 6px; scrollbar-width: thin; }
  .provider-label { margin: 0; padding: 8px 8px 5px 30px; color: var(--piui-text-faint); font-size: 9px; font-weight: 760; letter-spacing: .09em; text-transform: uppercase; }
  .provider-label:not(:first-child) { margin-top: 5px; border-top: 1px solid var(--piui-border-subtle); padding-top: 10px; }
  .model-options > button { display: flex; align-items: center; gap: 7px; width: 100%; min-height: 34px; padding: 5px 8px; border: 0; border-radius: 8px; background: transparent; color: var(--piui-text-muted); font-size: 12px; text-align: left; }
  .model-options > button.active { background: var(--piui-surface-2); color: var(--piui-text); }
  .model-options > button.selected { color: var(--piui-text); font-weight: 680; }
  .model-options > button:focus-visible { outline: 2px solid var(--piui-focus); outline-offset: -2px; }
  .check { display: grid; width: 15px; height: 15px; flex: 0 0 auto; place-items: center; color: var(--piui-accent); }
  .check svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 2; }
  .model-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .availability { margin-left: auto; color: var(--piui-warning); font-size: 9px; font-weight: 700; }
  .no-results { margin: 0; padding: 22px 10px; color: var(--piui-text-faint); font-size: 12px; text-align: center; }
  .result-limit { margin: 5px 0 0; padding: 8px; border-top: 1px solid var(--piui-border-subtle); color: var(--piui-text-faint); font-size: 10px; text-align: center; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  @media (max-width: 700px) { .model-trigger { max-width: 132px; }.model-menu { position: fixed; right: 14px; bottom: 84px; left: 14px; width: auto; } }
</style>
