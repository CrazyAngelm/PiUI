<script lang="ts">
  import type { SplitDirection } from './paneLayout';

  interface Props {
    direction: SplitDirection;
    ratio: number;
    label: string;
    onResize: (ratio: number) => void;
  }
  let { direction, ratio, label, onResize }: Props = $props();

  const STEP = 0.02;
  const BIG_STEP = 0.1;
  let element = $state<HTMLDivElement | null>(null);
  let dragging = $state(false);

  /** A row split sits between left and right panes, so its separator is vertical. */
  const orientation = $derived(direction === 'row' ? 'vertical' : 'horizontal');

  function ratioAt(event: PointerEvent): number | undefined {
    const box = element?.parentElement?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return undefined;
    return direction === 'row' ? (event.clientX - box.left) / box.width : (event.clientY - box.top) / box.height;
  }

  function down(event: PointerEvent): void {
    if (event.button !== 0 || !element) return;
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
    element.focus();
    dragging = true;
  }
  function move(event: PointerEvent): void {
    if (!dragging) return;
    const next = ratioAt(event);
    if (next !== undefined) onResize(next);
  }
  function end(event: PointerEvent): void {
    if (element?.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    dragging = false;
  }

  function key(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const step = event.shiftKey ? BIG_STEP : STEP;
    const less = direction === 'row' ? 'ArrowLeft' : 'ArrowUp';
    const more = direction === 'row' ? 'ArrowRight' : 'ArrowDown';
    if (event.key === less) onResize(ratio - step);
    else if (event.key === more) onResize(ratio + step);
    else if (event.key === 'Home') onResize(0.5);
    else return;
    event.preventDefault();
  }
</script>

<!-- A separator that can be focused is a widget: it takes the arrow keys, Home and a drag. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  bind:this={element}
  class="splitter splitter--{direction}"
  class:splitter--dragging={dragging}
  role="separator"
  tabindex="0"
  aria-orientation={orientation}
  aria-valuenow={Math.round(ratio * 100)}
  aria-valuemin={20}
  aria-valuemax={80}
  aria-label={label}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={end}
  onpointercancel={end}
  ondblclick={() => onResize(0.5)}
  onkeydown={key}
></div>

<style>
  .splitter {
    position: relative;
    z-index: 3;
    flex: none;
    background: var(--piui-border-subtle);
    outline: none;
    touch-action: none;
    transition: background-color var(--piui-duration-fast) var(--piui-ease-out);
  }
  .splitter--row {
    width: 1px;
    cursor: col-resize;
  }
  .splitter--column {
    height: 1px;
    cursor: row-resize;
  }
  /* The visible line is 1px; the grip is 5px. */
  .splitter::before {
    content: '';
    position: absolute;
  }
  .splitter--row::before {
    inset: 0 -2px;
  }
  .splitter--column::before {
    inset: -2px 0;
  }
  .splitter:hover,
  .splitter:focus-visible,
  .splitter--dragging {
    background: var(--piui-accent);
  }
  .splitter:focus-visible {
    box-shadow: 0 0 0 1px var(--piui-accent);
  }
</style>
