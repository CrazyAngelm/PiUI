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
  import type { Snippet } from 'svelte';
  import Brain from '@lucide/svelte/icons/brain';
  import Search from '@lucide/svelte/icons/search';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Zap from '@lucide/svelte/icons/zap';
  import { t } from '../../features/locale/language';
  import { Spinner, Switch } from '../../lib/ui';

  interface Props {
    models: readonly ModelOption[];
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

  const groups = $derived.by(() => {
    const byGroup = new Map<string, ModelOption[]>();
    for (const model of models) {
      const key = model.provider ?? '';
      byGroup.set(key, [...(byGroup.get(key) ?? []), model]);
    }
    return [...byGroup.entries()];
  });
  const steps = $derived<{ value: string; label: string }[]>([
    ...(levelDefault ? [{ value: '', label: $t('Auto') }] : []),
    ...levels.map((item) => ({ value: item, label: item })),
  ]);
  const activeStep = $derived(steps.findIndex((step) => step.value === level));
  const tuning = $derived(steps.length > 0 || fastAvailable);
  let gauge = $state<HTMLDivElement | null>(null);

  function choose(key: string, model: ModelOption | undefined): void {
    onModel(key);
    // Stay open when the new model has something to tune.
    if (!model || (!model.reasoning && !model.fast)) open = false;
  }

  function stepKey(event: KeyboardEvent, index: number): void {
    const last = steps.length - 1;
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowUp'
        ? Math.min(last, index + 1)
        : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
          ? Math.max(0, index - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : -1;
    if (next < 0) return;
    event.preventDefault();
    onLevel(steps[next]!.value);
    gauge?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
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
      <Command.Root label={$t('Model')} loop>
        <div class="piui-models__search">
          <Search size={14} />
          <Command.Input class="piui-models__input" placeholder={$t('Search models')} aria-label={$t('Search models')} />
          {#if loading}<Spinner size={12} />{/if}
        </div>
        <Command.List class="piui-models__list">
          <Command.Viewport>
            <Command.Empty class="piui-models__empty">
              {error ? $t('Could not load models') : loading ? $t('Loading models…') : $t('No models found')}
            </Command.Empty>
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
              <Command.Group>
                {#if group}<Command.GroupHeading class="piui-models__heading"><span>{group}</span></Command.GroupHeading>{/if}
                <Command.GroupItems>
                  {#each items as model (model.key)}
                    <Command.Item
                      class="piui-models__item"
                      value={`${group}\u0000${model.key}`}
                      keywords={[model.name, model.id]}
                      data-current={model.key === value ? '' : undefined}
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
                    </Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/each}
          </Command.Viewport>
        </Command.List>
      </Command.Root>

      <div class="piui-models__tune" class:piui-models__tune--busy={busy}>
        {#if steps.length}
          <div class="piui-models__row">
            <span class="piui-models__label"><Brain size={13} /> {$t('Reasoning')}</span>
            <span class="piui-models__value">{activeStep >= 0 ? steps[activeStep]!.label : $t('Native default')}</span>
          </div>
          <div class="piui-models__gauge" role="radiogroup" aria-label={$t('Reasoning')} bind:this={gauge} style="--steps: {steps.length}">
            {#each steps as step, index (step.value)}
              <button
                type="button"
                role="radio"
                class="piui-models__step"
                class:piui-models__step--lit={activeStep >= 0 && index <= activeStep && step.value !== ''}
                class:piui-models__step--auto={step.value === ''}
                aria-checked={index === activeStep}
                tabindex={index === (activeStep >= 0 ? activeStep : 0) ? 0 : -1}
                disabled={busy}
                title={step.label}
                onclick={() => onLevel(step.value)}
                onkeydown={(event) => stepKey(event, index)}
              >
                <span class="piui-models__bar" aria-hidden="true"></span>
                <span class="piui-models__steplabel">{step.label}</span>
              </button>
            {/each}
          </div>
        {/if}
        {#if fastAvailable}
          <div class="piui-models__row piui-models__row--fast">
            <span class="piui-models__label" class:piui-models__label--hot={fast}><Zap size={13} /> {$t('Fast mode')}</span>
            <Switch label={$t('Fast mode')} hideLabel={true} checked={fast} disabled={busy} onCheckedChange={(checked: boolean) => onFast(checked)} />
          </div>
        {/if}
        {#if !tuning}
          <p class="piui-models__hint">{hint || $t('This model has no reasoning options.')}</p>
        {/if}
        {#if error}<p class="piui-models__error" role="alert">{error}</p>{/if}
      </div>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>

<style>
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
  /* A crimson speed streak along the top edge. */
  .piui-models__streak {
    position: absolute;
    top: 0;
    left: 0;
    width: 62%;
    height: 2px;
    background: linear-gradient(90deg, var(--piui-chaos), var(--piui-chaos-gold) 55%, transparent);
    clip-path: polygon(0 0, 100% 0, 96% 100%, 0 100%);
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
  .piui-models__tune {
    display: grid;
    gap: var(--piui-space-2);
    padding: var(--piui-space-3);
    border-top: 1px solid var(--piui-border-subtle);
    background: color-mix(in srgb, var(--piui-bg-sunken) 55%, transparent);
  }
  .piui-models__tune--busy {
    opacity: 0.7;
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
  .piui-models__label--hot {
    color: var(--piui-chaos-gold);
  }
  .piui-models__value {
    color: var(--piui-text);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  /* Reasoning as a rising chaos-energy gauge: every level fits, none scroll. */
  .piui-models__gauge {
    display: grid;
    grid-template-columns: repeat(var(--steps), minmax(0, 1fr));
    gap: 4px;
  }
  .piui-models__step {
    display: grid;
    gap: 5px;
    justify-items: stretch;
    min-width: 0;
    padding: 4px 0 2px;
    border: 0;
    border-radius: var(--piui-radius-xs);
    background: transparent;
    color: var(--piui-text-muted);
    cursor: pointer;
  }
  .piui-models__step:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
  .piui-models__step:disabled {
    cursor: default;
  }
  .piui-models__bar {
    height: 10px;
    background: var(--piui-surface-3);
    clip-path: polygon(14% 0, 100% 0, 86% 100%, 0 100%);
    transition:
      background var(--piui-duration-fast) var(--piui-ease-out),
      box-shadow var(--piui-duration-fast) var(--piui-ease-out);
  }
  .piui-models__step:hover:not(:disabled) .piui-models__bar {
    background: color-mix(in srgb, var(--piui-chaos) 35%, var(--piui-surface-3));
  }
  .piui-models__step--lit .piui-models__bar {
    background: linear-gradient(90deg, var(--piui-chaos-deep), var(--piui-chaos));
  }
  .piui-models__step[aria-checked='true'] .piui-models__bar {
    background: linear-gradient(90deg, var(--piui-chaos), var(--piui-chaos-gold));
    box-shadow: 0 0 12px var(--piui-chaos-glow);
  }
  .piui-models__step--auto .piui-models__bar {
    background: repeating-linear-gradient(135deg, var(--piui-surface-3) 0 3px, transparent 3px 6px);
  }
  .piui-models__step--auto[aria-checked='true'] .piui-models__bar {
    background: repeating-linear-gradient(135deg, var(--piui-chaos-spark) 0 3px, transparent 3px 6px);
    box-shadow: none;
  }
  .piui-models__steplabel {
    overflow: hidden;
    font-size: var(--piui-text-xs);
    text-align: center;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .piui-models__step[aria-checked='true'] .piui-models__steplabel {
    color: var(--piui-text);
    font-weight: var(--piui-weight-semibold);
  }
  .piui-models__row--fast {
    padding-top: var(--piui-space-1);
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
  @media (prefers-reduced-motion: reduce) {
    .piui-models__bar {
      transition: none;
    }
  }
</style>
