<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../features/locale/language';
  export let label: string;
  export let storageKey: string;
  export let initial: number;
  export let minimum = initial;
  export let edge: 'left' | 'right';
  export let onresize: (width: number) => void;
  let width = initial;
  let handle: HTMLDivElement;
  let drag: { pointer: number; x: number; width: number } | undefined;
  // Preserve at least the neighbouring panel's original minimum footprint.
  function maximum(): number { return Math.max(minimum, (handle?.parentElement?.parentElement?.clientWidth ?? initial * 2) - initial); }
  function apply(value: number): void {
    width = Math.round(Math.max(minimum, Math.min(maximum(), value)));
    onresize(width);
    try { localStorage.setItem(storageKey, String(width)); } catch { /* Session resize remains available. */ }
  }
  onMount(() => {
    try { const saved = Number(localStorage.getItem(storageKey)); if (Number.isFinite(saved) && saved >= minimum) apply(saved); } catch { /* Use the layout default. */ }
    const resize = () => apply(width);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  });
  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Home') { event.preventDefault(); apply(initial); }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      apply(width + (event.key === 'ArrowRight' ? 1 : -1) * (edge === 'right' ? 1 : -1));
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions (WAI-ARIA window splitters are focusable separators with keyboard resizing.) -->
<div bind:this={handle} class="resize-handle" class:left={edge === 'left'} role="separator" aria-label={label} aria-orientation="vertical" aria-valuenow={width} aria-valuemin={minimum} aria-valuemax={maximum()} tabindex="0" title={$t('Drag to resize. Double-click to reset.')} onkeydown={keydown} ondblclick={() => apply(initial)}
  onpointerdown={(event) => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag = { pointer: event.pointerId, x: event.clientX, width }; }}
  onpointermove={(event) => { if (drag?.pointer === event.pointerId) apply(drag.width + (event.clientX - drag.x) * (edge === 'right' ? 1 : -1)); }}
  onpointerup={() => drag = undefined} onpointercancel={() => drag = undefined}>
</div>

<style>
  .resize-handle { position:absolute; inset-block:0; right:0; width:6px; z-index:3; cursor:col-resize; touch-action:none; }
  .resize-handle.left { right:auto; left:0; }
  .resize-handle::after { content:''; position:absolute; inset-block:0; left:2px; width:2px; background:transparent; }
  .resize-handle:hover::after, .resize-handle:focus-visible::after { background:var(--piui-accent); }
  .resize-handle:focus-visible { outline:1px solid var(--piui-focus); outline-offset:-1px; }
  @media(max-width:760px) { .resize-handle { display:none; } }
</style>
