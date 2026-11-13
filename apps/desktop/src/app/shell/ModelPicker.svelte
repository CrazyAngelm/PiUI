<script lang="ts" module>
  /** One model row; `key` is opaque to the picker (callers use provider+id). */
  export interface ModelOption {
    key: string;
    name: string;
    id: string;
    provider?: string;
    reasoning: boolean;
    fast: boolean;
  }
</script>

<script lang="ts">
  import { Command, Popover } from 'bits-ui';
  import { getContext, untrack, type Snippet } from 'svelte';
  import Brain from '@lucide/svelte/icons/brain';
  import Heart from '@lucide/svelte/icons/heart';
  import Lock from '@lucide/svelte/icons/lock';
  import LogIn from '@lucide/svelte/icons/log-in';
  import Search from '@lucide/svelte/icons/search';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Zap from '@lucide/svelte/icons/zap';
  import { NANO_MODEL_PROVIDER } from '../../../../../contracts/nano-account-v1';
  import { NANO_EXTERNAL_PROVIDER_PREFIX } from '../../../../../contracts/nano-providers-v1';
  import { NANO_CHATGPT_PROVIDER_ID } from '../../../../../contracts/nano-chatgpt-v1';
  import { nanoChatGpt } from '../../host-api/nanoProviders';
  import { isNanoConnectorModel } from '../../host-api/harnessModels';
  import { t } from '../../features/locale/language';
  import { Segmented, Spinner } from '../../lib/ui';
  import { nanoAccount } from '../nano/nanoAccount.svelte';
  import { lockCopy } from '../nano/nanoView';
  import type { WorkspaceStore } from '../workspaceStore.svelte';
  import { WORKSPACE_CONTEXT } from './context';
  import { modelFavorites } from './modelFavorites.svelte';
  import { defaultTab, favoriteKey, visibleModels, type ModelTab } from './modelPickerView';
  import ReasoningControl from './ReasoningControl.svelte';
  import { reasoningSteps } from './reasoningSteps';

  interface Props {
    models: readonly ModelOption[];
    /** Harness of the list: for `nano` the account's locked modes and a sign-in row follow the catalog rows. */
    harness?: string;
    /** Whose favorites the list shows; defaults to the harness. */
    favoritesScope?: string;
    /** Selected model key; '' is the harness default when `defaultOption` is set. */
    value: string;
    open?: boolean;
    /** Offer "use the harness model" as the first row. */
    defaultOption?: boolean;
    loading?: boolean;
    error?: string;
    /** Reasoning levels of the selected model, lowest first. */
    levels?: readonly string[];
    /** Selected level; '' means the native default. */
    level?: string;
    /** Whether '' (native default) can be picked as a level. */
    levelDefault?: boolean;
    fastAvailable?: boolean;
    fast?: boolean;
    busy?: boolean;
    /** Shown when the selected model has no tuning. */
    hint?: string;
    width?: number;
    side?: 'top' | 'bottom';
    align?: 'start' | 'center' | 'end';
    trigger: Snippet<[Record<string, unknown>]>;
    onModel: (key: string) => void;
    onLevel?: (level: string) => void;
    onFast?: (fast: boolean) => void;
  }

  let {
    models,
    harness = '',
    favoritesScope = undefined,
    value,
    open = $bindable(false),
    defaultOption = false,
    loading = false,
    error = '',
    levels = [],
    level = '',
    levelDefault = false,
    fastAvailable = false,
    fast = false,
    busy = false,
    hint = '',
    width = 380,
    side = 'bottom',
    align = 'start',
    trigger,
    onModel,
    onLevel = () => {},
    onFast = () => {},
  }: Props = $props();

  const nanoGroup = '\u0000nano';
  const chatGptGroup = '\u0000chatgpt';
  const externalGroup = '\u0000external';
  const usesChatGpt = $derived(harness === 'nano' && models.some(model => model.key === value && model.provider === NANO_CHATGPT_PROVIDER_ID));
  let manageUsageError = $state(false);

  // Favorites: a local preference per scope. A non-empty search always covers every model.
  const scope = $derived(favoritesScope ?? harness);
  const favoriteKeys = $derived(modelFavorites.list(scope));
  const favoriteSet = $derived(new Set(favoriteKeys));
  let tab = $state<ModelTab>('all');
  let kept = $state<string[]>([]);
  let search = $state('');
  let tabTouched = $state(false);
  let searchInput = $state<HTMLInputElement | null>(null);
  const searching = $derived(search.trim() !== '');
  const shownTab = $derived<ModelTab>(searching ? 'all' : tab);
  const listed = $derived(visibleModels(models, { tab, search, favorites: favoriteKeys, value, kept }));
  const tabOptions = $derived<{ value: ModelTab; label: string }[]>([
    { value: 'favorites', label: $t('Favorites') },
    { value: 'all', label: $t('All models') },
  ]);
  $effect(() => {
    if (!open) return;
    untrack(() => {
      kept = [];
      search = '';
      tabTouched = false;
    });
  });
  // The catalog can arrive after the popover opened: until the user picks a tab, follow it.
  $effect(() => {
    if (!open || tabTouched) return;
    tab = defaultTab(models, untrack(() => favoriteKeys));
  });

  function changeTab(next: ModelTab): void {
    tabTouched = true;
    tab = next;
    kept = [];
    search = '';
    searchInput?.focus();
  }

  function toggleFavorite(model: ModelOption): void {
    const key = favoriteKey(model);
    tabTouched = true;
    // Un-favoriting on the Favorites tab keeps the row until the tab changes or the popover closes.
    kept = favoriteSet.has(key) && shownTab === 'favorites' ? [...kept, key] : kept.filter((entry) => entry !== key);
    modelFavorites.toggle(scope, key);
  }

  function listKey(event: KeyboardEvent): void {
    // An IME composition owns its keys (Shift+Enter may commit the text).
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && event.shiftKey) {
      // Shift+Enter flips the favorite of the highlighted row and never picks it.
      event.preventDefault();
      const row = (event.currentTarget as HTMLElement).querySelector('[data-command-item][data-selected]');
      const key = row?.getAttribute('data-fav');
      const model = key ? models.find((entry) => favoriteKey(entry) === key) : undefined;
      if (model) toggleFavorite(model);
      return;
    }
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && event.target === searchInput && search === '' && !event.shiftKey) {
      event.preventDefault();
      const next: ModelTab = event.key === 'ArrowLeft' ? 'favorites' : 'all';
      if (next !== shownTab) changeTab(next);
    }
  }

  const groups = $derived.by(() => {
    const byGroup = new Map<string, ModelOption[]>();
    for (const model of listed) {
      const connector = isNanoConnectorModel(harness, model);
      if (connector && (!nanoAccount.status?.capabilities?.gateway
        || !nanoAccount.status.entitlements?.features.localAgent
        || !nanoAccount.availableModes.some(mode => mode.id === model.id))) continue;
      const external = harness === 'nano' && model.provider?.startsWith(NANO_EXTERNAL_PROVIDER_PREFIX);
      const key = (harness === 'nano' && model.provider === NANO_MODEL_PROVIDER) || connector
        ? nanoGroup : model.provider === NANO_CHATGPT_PROVIDER_ID ? chatGptGroup : external ? externalGroup : model.provider ?? '';
      byGroup.set(key, [...(byGroup.get(key) ?? []), model]);
    }
    return [...byGroup.entries()];
  });
  // A list can mix sources of one harness: the harness's own models (no provider) and
  // the account's Nano modes (provider `nano`, an agent with a Nano model source).
  // Each is its own group; the unnamed native group is named once there is another.
  function heading(group: string): string {
    if (group === nanoGroup) return 'Nano';
    if (group === chatGptGroup) return 'ChatGPT';
    if (group === externalGroup) return $t('External model providers');
    return group || (groups.length > 1 ? $t('Native models') : '');
  }
  // Nano: what the account does not allow, listed after the harness's own rows.
  const nano = $derived(harness === 'nano');
  const lockedModes = $derived(nano && shownTab === 'all' ? nanoAccount.lockedModes : []);
  const signInRow = $derived(nano && shownTab === 'all' && nanoAccount.needsSignIn);
  const workspace = getContext<WorkspaceStore | undefined>(WORKSPACE_CONTEXT);
  $effect(() => {
    if (nano) void nanoAccount.start();
  });

  function openAccount(): void {
    open = false;
    workspace?.navigate({ name: 'settings', section: 'nano' });
  }

  // The hint shows only when the reasoning control has nothing to offer.
  const tuning = $derived(reasoningSteps(levels, levelDefault).length > 0 || fastAvailable);

  function choose(key: string, model: ModelOption | undefined): void {
    onModel(key);
    // Stay open when the new model has something to tune.
    if (!model || (!model.reasoning && !model.fast)) open = false;
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      {@render trigger(props)}
    {/snippet}
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content class="piui-models" {align} {side} sideOffset={6} collisionPadding={8} style="width: {width}px">
      <span class="piui-models__streak" aria-hidden="true"></span>
      <Command.Root label={$t('Model')} loop onkeydown={listKey}>
        <div class="piui-models__search">
          <Search size={14} />
          <Command.Input class="piui-models__input" placeholder={$t('Search models')} aria-label={$t('Search models')} bind:value={search} bind:ref={searchInput} />
          {#if loading}<Spinner size={12} />{/if}
        </div>
        <div class="piui-models__tabs">
          <Segmented size="sm" label={$t('Models shown')} value={shownTab} options={tabOptions} onValueChange={changeTab} />
        </div>
        <Command.List class="piui-models__list">
          <Command.Viewport>
            <Command.Empty class="piui-models__empty">
              {error ? $t('Could not load models') : loading ? $t('Loading models…') : shownTab === 'favorites' ? $t('No favorites yet') : $t('No models found')}
            </Command.Empty>
            {#if shownTab === 'favorites' && defaultOption && listed.length === 0 && !loading && !error}
              <div class="piui-models__empty">{$t('No favorites yet')}</div>
            {/if}
            {#if defaultOption}
              <Command.Item
                class="piui-models__item"
                value={'\u0000default'}
                keywords={[$t('Harness default')]}
                data-current={value === '' ? '' : undefined}
                onSelect={() => choose('', undefined)}
              >
                <span class="piui-models__mark" aria-hidden="true"><Sparkles size={13} /></span>
                <span class="piui-models__main">
                  <span class="piui-models__name">{$t('Harness default')}</span>
                  <span class="piui-models__id piui-models__id--plain">{$t('Use the model configured in the harness')}</span>
                </span>
              </Command.Item>
            {/if}
            {#each groups as [group, items] (group)}
              {@const title = heading(group)}
              <Command.Group>
                {#if title}<Command.GroupHeading class="piui-models__heading"><span>{title}</span></Command.GroupHeading>{/if}
                <Command.GroupItems>
                  {#each items as model (model.key)}
                    {@const fav = favoriteSet.has(favoriteKey(model))}
                    <Command.Item
                      class="piui-models__item"
                      value={`${group}\u0000${model.key}`}
                      keywords={[model.name, model.id]}
                      data-current={model.key === value ? '' : undefined}
                      data-fav={favoriteKey(model)}
                      aria-keyshortcuts="Shift+Enter"
                      onSelect={() => choose(model.key, model)}
                    >
                      <span class="piui-models__mark" aria-hidden="true"></span>
                      <span class="piui-models__main">
                        <span class="piui-models__name">{model.name}</span>
                        <span class="piui-models__id">{model.id}</span>
                      </span>
                      <span class="piui-models__caps">
                        {#if model.reasoning}
                          <span class="piui-models__cap" title={$t('Supports reasoning levels')}>
                            <Brain size={12} aria-label={$t('reasoning')} />
                          </span>
                        {/if}
                        {#if model.fast}
                          <span class="piui-models__cap piui-models__cap--fast" title={$t('Supports fast mode')}>
                            <Zap size={12} aria-label={$t('fast')} />
                          </span>
                        {/if}
                      </span>
                      {#if fav}<span class="visually-hidden">, {$t('favorite')}</span>{/if}
                      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (Presentational inside an option, which cannot hold a button; the keyboard path is Shift+Enter on the row.) -->
                      <span
                        class="piui-models__fav"
                        class:piui-models__fav--on={fav}
                        aria-hidden="true"
                        title={fav ? $t('Remove from favorites (Shift+Enter)') : $t('Add to favorites (Shift+Enter)')}
                        onmousedown={(event) => event.preventDefault()}
                        onclick={(event) => {
                          event.stopPropagation();
                          toggleFavorite(model);
                        }}
                      >
                        <Heart size={14} fill={fav ? 'currentColor' : 'none'} />
                      </span>
                    </Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/each}
            {#if signInRow}
              <Command.Item class="piui-models__item" value={'\u0000nano-sign-in'} keywords={[$t('Sign in to use Nano'), 'nano', 'account']} onSelect={openAccount}>
                <span class="piui-models__mark" aria-hidden="true"><LogIn size={13} /></span>
                <span class="piui-models__main">
                  <span class="piui-models__name">{$t('Sign in to use Nano')}</span>
                </span>
              </Command.Item>
            {/if}
            {#each lockedModes as mode (mode.id)}
              <Command.Item class="piui-models__item" value={`nano-locked\u0000${mode.id}`} keywords={[mode.name, mode.id]} disabled>
                <span class="piui-models__mark" aria-hidden="true"><Lock size={12} /></span>
                <span class="piui-models__main">
                  <span class="piui-models__name">{mode.name}</span>
                  <span class="piui-models__id piui-models__id--plain">{$t(lockCopy(mode) ?? 'Disabled')}</span>
                </span>
              </Command.Item>
            {/each}
          </Command.Viewport>
        </Command.List>
      </Command.Root>

      <div class="piui-models__tune">
        <ReasoningControl {levels} {level} {levelDefault} {fastAvailable} {fast} {busy} {onLevel} {onFast} />
        {#if usesChatGpt}
          <div class="piui-models__row">
            <span class="piui-models__label">{$t('Using ChatGPT plan')}</span>
            <button type="button" class="manage-usage" onclick={async () => {
              manageUsageError = false;
              try { await nanoChatGpt({ type: 'manage-usage' }); } catch { manageUsageError = true; }
            }}>{$t('Manage usage')}</button>
          </div>
          {#if manageUsageError}<p class="piui-models__error" role="alert">{$t('Could not open ChatGPT in your browser.')}</p>{/if}
        {:else if !tuning}
          <p class="piui-models__hint">{hint || $t('This model has no reasoning options.')}</p>
        {/if}
        {#if error}<p class="piui-models__error" role="alert">{error}</p>{/if}
      </div>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>

<style>
  .manage-usage { color: var(--piui-text-muted); background: transparent; border: 0; text-decoration: underline; }
  :global(.piui-models) {
    position: relative;
    z-index: var(--piui-z-dropdown);
    display: flex;
    flex-direction: column;
    max-width: calc(100vw - 16px);
    max-height: min(540px, var(--bits-popover-content-available-height, 72vh));
    overflow: hidden;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-md);
    background:
      radial-gradient(120% 60% at 100% 0%, color-mix(in srgb, var(--piui-chaos) 9%, transparent), transparent 60%),
      var(--piui-surface-1);
    color: var(--piui-text);
    box-shadow: var(--piui-shadow-3), 0 0 0 1px color-mix(in srgb, var(--piui-chaos) 12%, transparent);
    outline: none;
    animation: piui-pop-in var(--piui-duration-fast) var(--piui-ease-out);
  }
  :global(.piui-models [data-command-root]) {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  /* A crimson speed streak along the whole top edge; the rounded corners clip its ends. */
  .piui-models__streak {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    height: 2px;
    background: linear-gradient(90deg, var(--piui-chaos), var(--piui-chaos-gold) 55%, var(--piui-chaos));
    pointer-events: none;
  }
  .piui-models__search {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    padding: 0 var(--piui-space-3);
    border-bottom: 1px solid var(--piui-border-subtle);
    color: var(--piui-text-muted);
  }
  :global(.piui-models__input) {
    flex: 1;
    min-width: 0;
    height: 38px;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--piui-text);
  }
  /* The search always holds focus while open; the global ring would be clipped. */
  :global(.piui-models__input:focus-visible) {
    outline: none;
  }
  :global(.piui-models__input::placeholder) {
    color: var(--piui-text-disabled);
  }
  :global(.piui-models__list) {
    /* Keep a few rows visible when a short window squeezes the popover. */
    min-height: 124px;
    padding: 4px;
    overflow-y: auto;
    scrollbar-width: thin;
  }
  :global(.piui-models__empty) {
    padding: var(--piui-space-4);
    color: var(--piui-text-muted);
    text-align: center;
  }
  :global(.piui-models__heading) {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    padding: 10px 8px 4px;
    color: var(--piui-chaos);
    font-size: 10px;
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  :global(.piui-models__heading)::after {
    content: '';
    flex: 1;
    height: 1px;
    background: linear-gradient(90deg, color-mix(in srgb, var(--piui-chaos) 45%, transparent), transparent);
  }
  :global(.piui-models__item) {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    min-height: 40px;
    padding: 5px var(--piui-space-2) 5px 6px;
    border-radius: var(--piui-radius-sm);
    cursor: default;
    outline: none;
    user-select: none;
  }
  :global(.piui-models__item[data-selected]) {
    background: var(--piui-hover);
  }
  /* Locked Nano modes stay visible but cannot be picked. */
  :global(.piui-models__item[data-disabled]) {
    opacity: 0.6;
  }
  :global(.piui-models__item[data-current]) {
    background: var(--piui-chaos-streak);
  }
  :global(.piui-models__item[data-current][data-selected]) {
    background: var(--piui-chaos-streak), var(--piui-hover);
  }
  /* The current model gets a slanted crimson blade instead of a checkmark. */
  .piui-models__mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 14px;
    height: 22px;
    color: var(--piui-text-muted);
  }
  :global(.piui-models__item[data-current]) .piui-models__mark {
    color: var(--piui-chaos);
  }
  :global(.piui-models__item[data-current]) .piui-models__mark:empty {
    width: 5px;
    margin: 0 5px 0 4px;
    background: linear-gradient(180deg, var(--piui-chaos-gold), var(--piui-chaos));
    clip-path: polygon(40% 0, 100% 0, 60% 100%, 0 100%);
    box-shadow: 0 0 10px var(--piui-chaos-glow);
  }
  .piui-models__main {
    display: grid;
    flex: 1;
    min-width: 0;
  }
  .piui-models__name,
  .piui-models__id {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .piui-models__name {
    font-weight: var(--piui-weight-medium, 500);
  }
  :global(.piui-models__item[data-current]) .piui-models__name {
    color: var(--piui-text);
    font-weight: var(--piui-weight-semibold);
  }
  .piui-models__id {
    color: var(--piui-text-disabled);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
  }
  .piui-models__id--plain {
    font-family: inherit;
  }
  .piui-models__caps {
    display: inline-flex;
    flex: none;
    gap: 3px;
  }
  .piui-models__cap {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border: 1px solid var(--piui-border-subtle);
    color: var(--piui-text-muted);
    clip-path: polygon(22% 0, 100% 0, 78% 100%, 0 100%);
    background: var(--piui-surface-2);
  }
  .piui-models__cap--fast {
    color: var(--piui-chaos-gold);
  }
  .piui-models__tabs {
    padding: var(--piui-space-2) var(--piui-space-2) 0;
  }
  .piui-models__tabs :global(.piui-seg) {
    display: flex;
    width: 100%;
  }
  .piui-models__tabs :global(.piui-seg__item) {
    flex: 1;
  }
  /* The heart sits calm and muted; lit it is a crimson heart with a gold rim. */
  .piui-models__fav {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 26px;
    height: 26px;
    border-radius: var(--piui-radius-xs);
    color: var(--piui-text-muted);
    cursor: pointer;
    transition: color var(--piui-duration-fast) var(--piui-ease-out);
  }
  .piui-models__fav:hover {
    color: var(--piui-chaos-gold);
  }
  .piui-models__fav--on {
    color: var(--piui-chaos);
  }
  .piui-models__fav--on :global(svg) {
    stroke: var(--piui-chaos-gold);
  }
  .piui-models__tune {
    display: grid;
    gap: var(--piui-space-2);
    padding: var(--piui-space-3);
    border-top: 1px solid var(--piui-border-subtle);
    background: color-mix(in srgb, var(--piui-bg-sunken) 55%, transparent);
  }
  .piui-models__row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-2);
  }
  .piui-models__label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .piui-models__hint,
  .piui-models__error {
    margin: 0;
    font-size: var(--piui-text-sm);
  }
  .piui-models__hint {
    color: var(--piui-text-muted);
  }
  .piui-models__error {
    color: var(--piui-danger);
  }
</style>
