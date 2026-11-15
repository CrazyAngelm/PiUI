<script lang="ts">
  import Brain from '@lucide/svelte/icons/brain';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Zap from '@lucide/svelte/icons/zap';
  import { t } from '../../features/locale/language';
  import { Switch } from '../../lib/ui';
  import { nearestStop, railPosition, railStops, RailGesture, reasoningSteps, stepForKey, type ReasoningStep } from './reasoningSteps';

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
  const stops = $derived(railStops(steps));
  const active = $derived(steps.findIndex((step) => step.value === level));
  // The hovered, focused or slid-over step: the readout names it and the ghost thumb marks it.
  let peek = $state(-1);
  const shown = $derived(peek >= 0 && peek < steps.length ? peek : active);
  const activeSlot = $derived(slotOf(active));
  const peekSlot = $derived(peek === active ? -1 : slotOf(peek));
  let group = $state<HTMLDivElement | null>(null);
  // The pointer press in progress. Plain state: only the handlers below read it.
  const gesture = new RailGesture();

  function slotOf(index: number): number {
    const step: ReasoningStep | undefined = steps[index];
    return step ? step.slot : -1;
  }

  function name(value: string): string {
    return value === '' ? $t('Auto') : $t(value);
  }

  function radios(): HTMLElement[] {
    return group ? Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]')) : [];
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
    radios()[next]?.focus();
  }

  function preview(index: number): void {
    if (!busy) peek = index;
  }

  function settle(index: number): void {
    if (!gesture.active && peek === index) peek = -1;
  }

  /** The step whose centre is nearest to a pointer position. */
  function stopAt(x: number): number {
    return nearestStop(
      x,
      radios().map((radio) => {
        const box = radio.getBoundingClientRect();
        return (box.left + box.right) / 2;
      }),
    );
  }

  function scrub(event: PointerEvent): void {
    if (!gesture.owns(event.pointerId)) return;
    const next = stopAt(event.clientX);
    if (next >= 0) peek = next;
  }

  function endPress(): void {
    gesture.end();
    window.removeEventListener('pointermove', scrub);
    window.removeEventListener('pointerup', release);
    window.removeEventListener('pointercancel', cancel);
  }

  function release(event: PointerEvent): void {
    if (!gesture.owns(event.pointerId)) return;
    // A release on the stop the press began on is a click, which picks it.
    const next = gesture.release(event.pointerId, stopAt(event.clientX));
    endPress();
    if (next < 0) return;
    peek = -1;
    pick(next);
    radios()[next]?.focus();
  }

  function cancel(event: PointerEvent): void {
    if (!gesture.owns(event.pointerId)) return;
    endPress();
    peek = -1;
  }

  // A touch pointer is captured by the stop it lands on, which would send its release, and the click after it, there.
  function releaseCapture(event: PointerEvent): void {
    const target = event.currentTarget;
    if (target instanceof Element && target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
  }

  // A press may slide along the rail: the release picks the stop under the pointer. Only that pointer steers it.
  function press(event: PointerEvent, index: number): void {
    if (busy || !event.isPrimary || event.button !== 0) return;
    endPress();
    releaseCapture(event);
    gesture.begin(event.pointerId, index);
    peek = index;
    window.addEventListener('pointermove', scrub);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', cancel);
  }

  // The click that trails a slide must not pick the stop the press began on and undo the slide.
  function click(event: MouseEvent, index: number): void {
    if (gesture.swallowsClick(event.detail)) return;
    pick(index);
  }

  // The popover can close in the middle of a press and take the control with it.
  $effect(() => endPress);
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
      <div
        class="gauge"
        class:gauge--auto={levelDefault}
        role="radiogroup"
        aria-label={$t('Reasoning')}
        style:--count={stops}
        style:--at={Math.max(activeSlot, 0)}
        style:--peek={Math.max(peekSlot, 0)}
        style:--fill={railPosition(activeSlot, stops)}
        bind:this={group}
      >
        <span class="track" aria-hidden="true"><span class="fill"></span></span>
        {#each steps as step, index (step.value)}
          {@const label = name(step.value)}
          <!-- Busy keeps the radios focusable (aria-disabled), so the keyboard never loses its place mid-change. -->
          <button
            type="button"
            role="radio"
            class="stop"
            class:stop--auto={step.kind === 'auto'}
            class:stop--zero={step.kind === 'zero'}
            class:stop--lit={step.slot >= 0 && step.slot <= activeSlot}
            class:stop--peek={index === peek && index !== active}
            aria-checked={index === active}
            aria-disabled={busy ? 'true' : undefined}
            tabindex={index === (active >= 0 ? active : 0) ? 0 : -1}
            title={label}
            style:--pos={step.slot >= 0 ? railPosition(step.slot, stops) : undefined}
            onclick={(event) => click(event, index)}
            onkeydown={(event) => key(event, index)}
            onpointerdown={(event) => press(event, index)}
            onpointerenter={() => preview(index)}
            onpointerleave={() => settle(index)}
            onfocus={() => preview(index)}
            onblur={() => settle(index)}
          >
            {#if step.kind === 'auto'}
              <span class="dock" aria-hidden="true"><Sparkles size={13} /></span>
            {:else}
              <span class="tick" aria-hidden="true"></span>
            {/if}
            <span class="visually-hidden">{label}</span>
          </button>
        {/each}
        <span class="thumb thumb--ghost" class:thumb--off={peekSlot < 0} aria-hidden="true"></span>
        <span class="thumb" class:thumb--off={activeSlot < 0} aria-hidden="true"></span>
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
    flex: none;
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
  /* On: the bolt takes the decoration accent and the label takes full contrast. */
  .title--on {
    color: var(--piui-text);
  }
  .title--on :global(svg) {
    color: var(--piui-decoration-secondary);
  }
  .readout {
    min-width: 0;
    overflow: hidden;
    color: var(--piui-text);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
    letter-spacing: 0.08em;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .readout--quiet {
    color: var(--piui-text-muted);
  }

  /* One row: Auto docked at the start, then a rail with a stop per level. */
  .gauge {
    --tilt: var(--piui-decoration-gauge-tilt);
    /* Width Auto takes before the rail starts: its 28px button and an 8px gap. */
    --dock: 0px;
    position: relative;
    display: flex;
    align-items: center;
    height: 28px;
    touch-action: none;
  }
  .gauge--auto {
    --dock: 36px;
  }
  /* The buttons are never transformed, so hit areas and pointer math stay rectangular. */
  .stop {
    position: relative;
    display: grid;
    place-items: center;
    flex: 1 1 0;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    font-family: inherit;
    cursor: pointer;
  }
  .stop[aria-disabled='true'] {
    cursor: default;
  }
  .stop--auto {
    flex: none;
    width: 28px;
    margin-right: 8px;
  }
  /* The focus ring hugs the thumb position instead of boxing the whole hit area. */
  .stop:focus-visible {
    outline: none;
  }
  .stop:not(.stop--auto):focus-visible::after {
    content: '';
    position: absolute;
    top: 1px;
    bottom: 1px;
    left: 50%;
    width: 18px;
    margin-left: -9px;
    border-radius: calc(var(--piui-decoration-radius) * 1.5);
    outline: 2px solid var(--piui-focus);
    transform: skewX(var(--tilt));
  }
  .stop--auto:focus-visible .dock {
    outline: 2px solid var(--piui-focus);
    outline-offset: 2px;
  }

  /* Auto: the native default, marked with the same icon as "Harness default" in the list. */
  .dock {
    position: relative;
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border: 1px solid var(--piui-border);
    border-radius: calc(var(--piui-decoration-radius) * 2);
    background: var(--piui-surface-2);
    color: var(--piui-text-muted);
    transform: skewX(var(--tilt));
  }
  /* The chosen Auto lights up in the style's spark accent. Only its opacity animates. */
  .dock::after {
    content: '';
    position: absolute;
    inset: -1px;
    border: 1px solid color-mix(in srgb, var(--piui-decoration-spark) 60%, var(--piui-border));
    border-radius: inherit;
    background: color-mix(in srgb, var(--piui-decoration-spark) 14%, transparent);
    box-shadow: 0 0 12px var(--piui-decoration-glow);
    opacity: 0;
    transition: opacity var(--piui-duration-fast) var(--piui-ease-out);
  }
  /* The icon stays upright inside the slanted dock. */
  .dock :global(svg) {
    position: relative;
    z-index: 1;
    transform: skewX(calc(var(--tilt) * -1));
  }
  .stop--peek .dock {
    border-color: var(--piui-border-strong);
    color: var(--piui-text);
  }
  .stop--auto[aria-checked='true'] .dock {
    color: var(--piui-decoration-spark);
  }
  .stop--auto[aria-checked='true'] .dock::after {
    opacity: 1;
  }

  /* The rail runs between the centres of the first and last stop and thickens toward the top level. */
  .track {
    position: absolute;
    top: 50%;
    right: calc((100% - var(--dock)) / var(--count) / 2);
    left: calc(var(--dock) + (100% - var(--dock)) / var(--count) / 2);
    height: 10px;
    margin-top: -5px;
    border-radius: var(--piui-decoration-radius);
    background: color-mix(in srgb, var(--piui-text) 14%, transparent);
    clip-path: polygon(0 40%, 100% 0, 100% 100%, 0 60%);
    transform: skewX(var(--tilt));
    pointer-events: none;
  }
  /* The visual style supplies both accents of the charge. */
  .fill {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--piui-decoration-primary) 60%, transparent),
      var(--piui-decoration-primary) 45%,
      var(--piui-decoration-secondary)
    );
    transform: scaleX(var(--fill));
    transform-origin: 0 50%;
    transition: transform var(--piui-duration) var(--piui-ease-out);
  }
  .tick {
    width: 2px;
    height: calc(6px + 8px * var(--pos, 0));
    border-radius: var(--piui-decoration-radius);
    background: color-mix(in srgb, var(--piui-text) 34%, transparent);
    transform: skewX(var(--tilt));
  }
  .stop--lit .tick {
    background: color-mix(in srgb, var(--piui-decoration-secondary) 50%, var(--piui-text));
  }
  /* A zero level is a hollow stop; its centre matches the picker's sunken footer. */
  .stop--zero .tick {
    width: 6px;
    height: 6px;
    background: color-mix(in srgb, var(--piui-bg-sunken) 55%, var(--piui-surface-1));
    box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--piui-text) 46%, transparent);
  }
  .stop--zero.stop--lit .tick {
    box-shadow: inset 0 0 0 1.5px var(--piui-decoration-primary);
  }

  /* One stop wide and moved by whole stops, so only its transform animates. */
  .thumb {
    position: absolute;
    top: 0;
    bottom: 0;
    left: var(--dock);
    display: grid;
    place-items: center;
    width: calc((100% - var(--dock)) / var(--count));
    transform: translateX(calc(var(--at) * 100%));
    transition:
      transform var(--piui-duration) var(--piui-ease-out),
      opacity var(--piui-duration-fast) var(--piui-ease-out);
    pointer-events: none;
  }
  .thumb::before {
    content: '';
    width: 10px;
    height: 20px;
    border-radius: var(--piui-decoration-radius);
    background: var(--piui-decoration-secondary);
    box-shadow:
      0 0 0 3px color-mix(in srgb, var(--piui-decoration-secondary) 24%, transparent),
      0 0 14px var(--piui-decoration-glow);
    transform: skewX(var(--tilt));
  }
  /* The previewed stop: an outline that jumps, never sweeps. */
  .thumb--ghost {
    opacity: 0.75;
    transform: translateX(calc(var(--peek) * 100%));
    transition: none;
  }
  .thumb--ghost::before {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px var(--piui-decoration-secondary);
  }
  .thumb--off {
    opacity: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .reasoning,
    .fill,
    .thumb,
    .dock::after {
      transition: none;
    }
  }
</style>
