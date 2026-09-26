<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { t } from '../features/locale/language';
  export let label: string;
  export let storageKey: string;
  export let width: number;
  export let height: number;
  export let bounds: {left:number;top:number;right:number;bottom:number} | undefined = undefined;
  export let zoom = 1;
  export let canvas: HTMLDivElement;
  export let world: HTMLDivElement;
  export let onclick: (event: MouseEvent) => void = () => {};
  let viewportWidth = 0, viewportHeight = 0;
  let mounted = false, savedKey = '', restoring = false;
  let space = false;
  let pan: { pointer: number; x: number; y: number; left: number; top: number } | undefined;
  let suppressClick = false;
  let frame = 0;
  $: worldWidth = Math.max(width, viewportWidth / zoom);
  $: worldHeight = Math.max(height, viewportHeight / zoom);
  $: if (mounted && savedKey !== storageKey) { savedKey = storageKey; void restore(); }
  function persist(): void {
    if (!mounted || !canvas || restoring || storageKey !== savedKey) return;
    try { localStorage.setItem(storageKey, JSON.stringify({ zoom, left: canvas.scrollLeft, top: canvas.scrollTop })); } catch { /* View metadata is optional. */ }
  }
  async function restore(): Promise<void> {
    const expected = storageKey;
    restoring = true;
    let view = { zoom: 1, left: 0, top: 0 };
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      if (stored && [stored.zoom, stored.left, stored.top].every(Number.isFinite) && stored.zoom > 0 && stored.left >= 0 && stored.top >= 0) view = stored;
    } catch { /* Ignore damaged UI metadata. */ }
    zoom = view.zoom;
    await tick(); if (expected !== storageKey) return; canvas.scrollTo(view.left, view.top); restoring = false;
  }
  export async function scale(next: number, x = canvas.clientWidth / 2, y = canvas.clientHeight / 2): Promise<void> {
    if (!Number.isFinite(next) || next <= 0) return;
    const left = (canvas.scrollLeft + x) / zoom * next - x;
    const top = (canvas.scrollTop + y) / zoom * next - y;
    zoom = next; await tick(); canvas.scrollTo(left, top); persist();
  }
  export async function focusBounds(bounds: { left: number; top: number; right: number; bottom: number }, fit = false): Promise<void> {
    if (fit) zoom = Math.min(1, canvas.clientWidth / Math.max(1, bounds.right - bounds.left), canvas.clientHeight / Math.max(1, bounds.bottom - bounds.top));
    await tick();
    canvas.scrollTo(Math.max(0, (bounds.left + bounds.right) * zoom / 2 - canvas.clientWidth / 2), Math.max(0, (bounds.top + bounds.bottom) * zoom / 2 - canvas.clientHeight / 2)); persist();
  }
  export async function reset(): Promise<void> { zoom = 1; await tick(); canvas.scrollTo(0, 0); persist(); }
  function fit(): void { void focusBounds(bounds ?? { left: 0, top: 0, right: width, bottom: height }, true); }
  function wheel(event: WheelEvent): void {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? parseFloat(getComputedStyle(canvas).fontSize) : event.deltaMode === 2 ? canvas.clientHeight : 1;
    const bounds = canvas.getBoundingClientRect();
    // One viewport of gesture motion doubles/halves the scale; adapts to wheel units.
    void scale(zoom * 2 ** (-event.deltaY * unit / canvas.clientHeight), event.clientX - bounds.left, event.clientY - bounds.top);
  }
  function keydown(event: KeyboardEvent): void {
    if ((event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]')) return;
    if (event.code === 'Space' && event.target === canvas) { event.preventDefault(); space = true; }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === '+' || event.key === '=') { event.preventDefault(); void scale(zoom * 1.2); }
    if (event.key === '-') { event.preventDefault(); void scale(zoom / 1.2); }
    if (event.key === '0') { event.preventDefault(); void reset(); }
    if (event.key.toLowerCase() === 'f') { event.preventDefault(); fit(); }
  }
  function pointerdown(event: PointerEvent): void {
    suppressClick = false;
    if (event.button !== 1 && !(event.button === 0 && space)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    canvas.setPointerCapture(event.pointerId); canvas.focus({ preventScroll: true }); suppressClick = event.button === 0;
    pan = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: canvas.scrollLeft, top: canvas.scrollTop };
  }
  function pointermove(event: PointerEvent): void {
    if (pan?.pointer !== event.pointerId) return;
    canvas.scrollLeft = pan.left + pan.x - event.clientX; canvas.scrollTop = pan.top + pan.y - event.clientY;
  }
  function endPan(): void { if (pan && canvas.hasPointerCapture(pan.pointer)) canvas.releasePointerCapture(pan.pointer); pan = undefined; persist(); }
  function captureClick(event: MouseEvent): void { if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; } }
  onMount(() => {
    mounted = true;
    const observer = new ResizeObserver(() => { viewportWidth = canvas.clientWidth; viewportHeight = canvas.clientHeight; });
    observer.observe(canvas);
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('pointerdown', pointerdown, true);
    canvas.addEventListener('click', captureClick, true);
    const release = () => { space = false; endPan(); };
    window.addEventListener('blur', release);
    return () => { persist(); mounted = false; observer.disconnect(); canvas.removeEventListener('wheel', wheel); canvas.removeEventListener('pointerdown', pointerdown, true); canvas.removeEventListener('click', captureClick, true); window.removeEventListener('blur', release); cancelAnimationFrame(frame); };
  });
</script>
<svelte:window onkeyup={(event) => { if (event.code === 'Space') space = false; }} />
<div class="graph-navigation" aria-label={$t('Canvas navigation')}>
  <button aria-label={$t('Zoom out')} onclick={() => scale(zoom / 1.2)}>−</button>
  <button aria-label={$t('Reset view')} onclick={reset}>{Math.round(zoom * 100)}%</button>
  <button aria-label={$t('Zoom in')} onclick={() => scale(zoom * 1.2)}>＋</button>
  <button onclick={fit}>{$t('Fit')}</button>
  <details><summary>{$t('Canvas controls')}</summary><p>{$t('Ctrl + wheel or pinch to zoom. Middle drag to pan. Focus the canvas, then Space + drag to pan; + / − to zoom, 0 to reset, F to fit.')}</p></details>
</div>
<!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_no_noninteractive_tabindex (Focusable graph scroll region supports keyboard navigation.) -->
<div bind:this={canvas} class="canvas" class:panning={pan !== undefined || space} tabindex="0" role="region" aria-label={label} onkeydown={keydown} onpointermove={pointermove} onpointerup={endPan} onpointercancel={endPan} onscroll={() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(persist); }} onclick={(event) => { if (suppressClick) { suppressClick = false; return; } onclick(event); }}>
  <slot name="overlay" />
  <div style:width={`${worldWidth * zoom}px`} style:height={`${worldHeight * zoom}px`}>
    <div bind:this={world} class="world" style:width={`${worldWidth}px`} style:height={`${worldHeight}px`} style:transform={`scale(${zoom})`}><slot /></div>
  </div>
</div>
<style>
  .graph-navigation { display:flex; align-items:center; gap:var(--piui-space-1); padding:var(--piui-space-2); border-block:1px solid var(--piui-border-subtle); flex-wrap:wrap; }
  button,summary { font:inherit; padding:5px 8px; color:var(--piui-text); border:1px solid var(--piui-border-subtle); border-radius:var(--piui-radius-sm); background:var(--piui-bg-raised); cursor:pointer; }
  button:focus-visible,summary:focus-visible,.canvas:focus-visible { outline:2px solid var(--piui-focus); outline-offset:-2px; }
  details { position:relative; margin-left:auto; font-size:12px; } details p { position:absolute; right:0; top:100%; z-index:5; width:240px; padding:12px; background:var(--piui-bg-raised); border:1px solid var(--piui-border); }
  .canvas { position:relative; overflow:auto; flex:1; min-height:0; background-color:var(--piui-bg); background-image:radial-gradient(var(--piui-border-subtle) .7px,transparent .7px); background-size:20px 20px; }
  .canvas.panning { cursor:grab; } .world { position:relative; transform-origin:0 0; }
</style>
