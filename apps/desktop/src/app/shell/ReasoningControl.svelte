<script lang="ts">
  import Brain from '@lucide/svelte/icons/brain';
  import Zap from '@lucide/svelte/icons/zap';
  import { t } from '../../features/locale/language';
  import { Switch } from '../../lib/ui';
  import { litFrontier, reasoningSteps, stepForKey, stepTone, sweepSlot } from './reasoningSteps';

  interface Props {
    /** Reasoning levels of the selected model, lowest first. */
    levels?: readonly string[];
    /** Selected level; '' means the native default. */
    level?: string;
    /** Whether '' (native default) can be picked as a level. */
    levelDefault?: boolean;
    fastAvailable?: boolean;
    fast?: boolean;
    /** A change is being applied or tuning is unavailable: nothing can be picked. */
    busy?: boolean;
    onLevel?: (level: string) => void;
    onFast?: (fast: boolean) => void;
  }

  let {
    levels = [],
    level = '',
    levelDefault = false,
    fastAvailable = false,
    fast = false,
    busy = false,
    onLevel = () => {},
    onFast = () => {},
  }: Props = $props();

  const uid = $props.id();
  const steps = $derived(reasoningSteps(levels, levelDefault));
  const active = $derived(steps.findIndex((step) => step.value === level));
  // The hovered or focused step: the readout names it and the ramp previews it.
  let peek = $state(-1);
  const shown = $derived(peek >= 0 && peek < steps.length ? peek : active);
  let group = $state<HTMLDivElement | null>(null);

  // The frontier painted before the latest change, so only newly lit bars are staggered.
  const frontier = $derived(litFrontier(steps, active));
  let painted = -1;
  const sweepFrom = $derived.by(() => {
    void frontier;
    return painted;
  });
  $effect(() => {
    painted = frontier;
  });

  function name(value: string): string {
    return value === '' ? $t('Auto') : $t(value);
  }

  function pick(index: number): void {
    const step = steps[index];
    if (busy || !step || index === active) return;
    onLevel(step.value);
  }

  function key(event: KeyboardEvent, index: number): void {
    const next = stepForKey(event.key, index, steps.length);
    if (next < 0) return;
    event.preventDefault();
    if (busy) return;
    pick(next);
    group?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  }

  function preview(index: number): void {
    if (!busy) peek = index;
  }

  function settle(index: number): void {
    if (peek === index) peek = -1;
  }
</script>

{#if steps.length > 0 || fastAvailable}
  <div class="reasoning" class:reasoning--busy={busy}>
    {#if steps.length > 0}
      <div class="row">
        <span class="title"><Brain size={13} /> {$t('Reasoning')}</span>
        <span class="readout" class:readout--quiet={active < 0 || shown !== active} aria-hidden="true">
          {shown >= 0 ? name(steps[shown]!.value) : $t('Native default')}
        </span>
      </div>
      <div class="ramp" role="radiogroup" aria-label={$t('Reasoning')} bind:this={group}>
        {#each steps as step, index (step.value)}
          {@const tone = stepTone(steps, index, active, peek)}
          {@const label = name(step.value)}
          <!-- Busy keeps the radios focusable (aria-disabled), so the keyboard never loses its place mid-change. -->
          <button
            type="button"
            role="radio"
            class="step"
            class:step--auto={step.kind === 'auto'}
            class:step--zero={step.kind === 'zero'}
            class:step--ghost={tone === 'ghost'}
            class:step--fade={tone === 'fade'}
            class:step--lit={tone === 'lit'}
            aria-checked={index === active}
            aria-disabled={busy ? 'true' : undefined}
            tabindex={index === (active >= 0 ? active : 0) ? 0 : -1}
            title={step.kind === 'auto' ? undefined : label}
            style:--rise={step.kind === 'level' ? step.rise : undefined}
            style:--lag={step.kind === 'level' ? sweepSlot(step.rank, sweepFrom) : undefined}
            onclick={() => pick(index)}
            onkeydown={(event) => key(event, index)}
            onpointerenter={() => preview(index)}
            onpointerleave={() => settle(index)}
            onfocus={() => preview(index)}
            onblur={() => settle(index)}
          >
            {#if step.kind === 'auto'}
              <span class="name">{label}</span>
            {:else}
              <span class="bar" aria-hidden="true"></span>
              <span class="visually-hidden">{label}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
    {#if fastAvailable}
      <div class="row">
        <label class="title title--fast" class:title--on={fast} for="{uid}-fast"><Zap size={13} /> {$t('Fast mode')}</label>
        <Switch id="{uid}-fast" label={$t('Fast mode')} hideLabel={true} checked={fast} disabled={busy} onCheckedChange={(checked: boolean) => onFast(checked)} />
      </div>
    {/if}
  </div>
{/if}

<style>
  .reasoning {
    display: grid;
    gap: var(--piui-space-2);
    transition: opacity var(--piui-duration-fast) var(--piui-ease-out);
  }
  /* The dim waits a beat, so a quick round trip to the harness never flickers. */
  .reasoning--busy {
    opacity: 0.7;
    transition-duration: calc(var(--piui-duration-fast) / 2);
    transition-delay: var(--piui-duration-fast);
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-2);
  }
  .title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .title--fast {
    cursor: pointer;
  }
  .reasoning--busy .title--fast {
    cursor: default;
  }
  /* On: the bolt turns gold and the label takes full contrast, readable in both themes. */
  .title--on {
    color: var(--piui-text);
  }
  .title--on :global(svg) {
    color: var(--piui-chaos-gold);
  }
  .readout {
    color: var(--piui-text);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .readout--quiet {
    color: var(--piui-text-muted);
  }

  /* Slanted steps rising from one baseline; the top 4px is headroom for the gold cap. */
  .ramp {
    --tilt: -12deg;
    display: flex;
    align-items: flex-end;
    gap: 4px;
    height: 32px;
    /* A full-height step leans this far right at its top: 32px x tan(12deg). */
    padding-right: 7px;
  }
  /* The whole hit area is skewed, so the pointer, the focus ring and the bar share one slant. */
  .step {
    position: relative;
    flex: 1 1 0;
    min-width: 18px;
    max-width: 52px;
    height: 100%;
    padding: 0;
    border-radius: 2px;
    background: transparent;
    font-family: inherit;
    cursor: pointer;
    transform: skewX(var(--tilt));
    transform-origin: 0 100%;
  }
  .step:focus-visible {
    z-index: 1;
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
  .step[aria-disabled='true'] {
    cursor: default;
  }
  .bar {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: calc(8px + 20px * var(--rise, 0));
    border-radius: 2px;
    background: color-mix(in srgb, var(--piui-text) 16%, transparent);
    transform-origin: 50% 100%;
    transition: transform var(--piui-duration-fast) var(--piui-ease-out);
  }
  .step--zero .bar {
    height: 4px;
  }
  .step:active:not([aria-disabled='true']) .bar {
    transform: scaleY(0.92);
  }
  /* Heat: crimson at the lowest level, gold at the highest. Only its opacity ever animates. */
  .bar::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: color-mix(in srgb, var(--piui-chaos-gold) calc(var(--rise, 0) * 100%), var(--piui-chaos));
    opacity: 0;
    transition: opacity var(--piui-duration-fast) var(--piui-ease-out);
  }
  .step--ghost .bar::before {
    opacity: 0.32;
  }
  .step--fade .bar::before {
    opacity: 0.4;
  }
  /* Bars light up in a short sweep from the previous level. */
  .step--lit .bar::before {
    opacity: 1;
    transition-delay: calc(var(--lag, 0) * var(--piui-duration-fast) / 6);
  }
  .step[aria-checked='true'] .bar::before {
    box-shadow: 0 0 12px var(--piui-chaos-glow);
  }
  /* The chosen step holds a gold cap above it, also while another level is previewed. */
  .bar::after {
    content: '';
    position: absolute;
    right: 0;
    bottom: calc(100% + 2px);
    left: 0;
    height: 2px;
    border-radius: 1px;
    background: var(--piui-chaos-gold);
    opacity: 0;
    transition: opacity var(--piui-duration-fast) var(--piui-ease-out);
  }
  .step[aria-checked='true'] .bar::after {
    opacity: 1;
    transition-delay: calc(var(--lag, 0) * var(--piui-duration-fast) / 6);
  }

  /* Auto stands apart from the ramp: the model decides, so it carries the emerald spark, not heat. */
  .step--auto {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: none;
    height: 28px;
    margin-right: 6px;
    padding: 0 10px 0 8px;
    border: 1px solid var(--piui-border);
    border-radius: 3px;
    background: var(--piui-surface-2);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .step--auto::before {
    content: '';
    flex: none;
    width: 4px;
    height: 10px;
    border-radius: 1px;
    background: var(--piui-border-strong);
  }
  .step--auto::after {
    content: '';
    position: absolute;
    right: -1px;
    bottom: -1px;
    left: -1px;
    height: 2px;
    border-radius: 0 0 3px 3px;
    background: var(--piui-chaos-spark);
    opacity: 0;
    transition: opacity var(--piui-duration-fast) var(--piui-ease-out);
  }
  .step--auto:hover:not([aria-disabled='true']),
  .step--auto[aria-checked='true'] {
    color: var(--piui-text);
  }
  .step--auto[aria-checked='true'] {
    border-color: color-mix(in srgb, var(--piui-chaos-spark) 45%, var(--piui-border));
    background: color-mix(in srgb, var(--piui-chaos-spark) 9%, var(--piui-surface-2));
  }
  .step--auto[aria-checked='true']::before {
    background: var(--piui-chaos-spark);
  }
  .step--auto[aria-checked='true']::after {
    opacity: 1;
  }
  /* The label stays upright inside the slanted chip. */
  .name {
    transform: skewX(calc(var(--tilt) * -1));
  }

  @media (prefers-reduced-motion: reduce) {
    .reasoning,
    .bar,
    .bar::before,
    .bar::after,
    .step--auto::after {
      transition: none;
    }
  }
</style>
