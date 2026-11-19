<script lang="ts">
  import { Spinner } from '../../../lib/ui';
  import TeammateAvatar from '../../team/TeammateAvatar.svelte';
  import type { ComposerMenuItem } from './menuItems';
  import { MENU_MAX_HEIGHT, menuPlacement, type MenuPlacement } from './menuPlacement';

  interface Props {
    /** DOM id; option ids are `${id}-${index}` for aria-activedescendant. */
    id: string;
    label: string;
    items: readonly ComposerMenuItem[];
    active: number;
    loading?: boolean;
    /** Shown when there is nothing to pick. */
    emptyText?: string;
    onPick: (index: number) => void;
  }
  let { id, label, items, active, loading = false, emptyText = '', onPick }: Props = $props();

  /** Space kept between the menu and the field, and between the menu and the edge it must not cross. */
  const GAP = 6;
  const EDGE = 8;

  let menu = $state<HTMLDivElement | null>(null);
  let placement = $state.raw<MenuPlacement | undefined>();
  /** A column for the digits, so titles line up even where a row has none. */
  const numbered = $derived(items.some((item) => item.number !== undefined));

  const shortcuts = (item: ComposerMenuItem): string | undefined => {
    const keys = [item.number === undefined ? '' : String(item.number), item.accelerator ?? ''].filter(Boolean);
    return keys.length ? keys.join(' ') : undefined;
  };

  /** The boxes around the field that clip or scroll what is inside them. */
  function clippers(from: HTMLElement): HTMLElement[] {
    const boxes: HTMLElement[] = [];
    for (let node = from.parentElement; node; node = node.parentElement) {
      if (getComputedStyle(node).overflowY !== 'visible') boxes.push(node);
    }
    return boxes;
  }

  /** What the eye can see around the field: the visible part of the window (a phone keyboard covers the rest), narrowed by every box that clips or scrolls. */
  function visibleBand(boxes: readonly HTMLElement[]): { top: number; bottom: number } {
    const viewport = window.visualViewport;
    let top = viewport ? viewport.offsetTop : 0;
    let bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    for (const node of boxes) {
      const box = node.getBoundingClientRect();
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.bottom);
    }
    return { top, bottom };
  }

  /** The menu grows up to a limit and scrolls inside itself; it never runs past the top of the window or of a scrolling page. */
  function measure(): void {
    const node = menu;
    const host = node?.offsetParent;
    if (!node || !(host instanceof HTMLElement)) return;
    const field = host.getBoundingClientRect();
    const band = visibleBand(clippers(host));
    const next = menuPlacement(
      { above: field.top - band.top - GAP - EDGE, below: band.bottom - field.bottom - GAP - EDGE },
      Math.min(MENU_MAX_HEIGHT, window.innerHeight * 0.55),
    );
    if (placement?.side !== next.side || placement.height !== next.height) placement = next;
  }

  $effect(() => {
    const node = menu;
    if (!node) return;
    measure();
    const changed = (event: Event): void => {
      // The menu's own scrolling does not move it.
      if (event.target !== node) measure();
    };
    // The field and every box around it: dragging a pane divider moves the edge while the field keeps its size.
    const observer = new ResizeObserver(measure);
    const host = node.offsetParent;
    if (host instanceof HTMLElement) {
      observer.observe(host);
      for (const box of clippers(host)) observer.observe(box);
    }
    const viewport = window.visualViewport;
    window.addEventListener('resize', changed);
    window.addEventListener('scroll', changed, { capture: true, passive: true });
    viewport?.addEventListener('resize', changed);
    viewport?.addEventListener('scroll', changed);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', changed);
      window.removeEventListener('scroll', changed, { capture: true });
      viewport?.removeEventListener('resize', changed);
      viewport?.removeEventListener('scroll', changed);
    };
  });

  // The arrow keys move the highlight, and a shorter menu may cover it: the menu follows it, group heading included.
  $effect(() => {
    void placement?.height;
    const box = menu;
    const row = document.getElementById(`${id}-${active}`);
    if (!box || !row || !box.contains(row) || items.length === 0) return;
    const lead = row.previousElementSibling?.classList.contains('menu__group') ? (row.previousElementSibling as HTMLElement) : row;
    const bottom = row.offsetTop + row.offsetHeight;
    if (lead.offsetTop < box.scrollTop + 4) box.scrollTop = Math.max(0, lead.offsetTop - 4);
    else if (bottom > box.scrollTop + box.clientHeight - 4) box.scrollTop = bottom - box.clientHeight + 4;
  });
</script>

<div
  class="menu"
  class:menu--below={placement?.side === 'below'}
  style:max-height={placement ? `${placement.height}px` : undefined}
  {id}
  role="listbox"
  aria-label={label}
  aria-busy={loading || undefined}
  bind:this={menu}
>
  {#each items as item, index (item.key)}
    {#if item.group && item.group !== items[index - 1]?.group}
      <div class="menu__group" role="presentation">{item.group}</div>
    {/if}
    <button
      type="button"
      id={`${id}-${index}`}
      role="option"
      tabindex="-1"
      aria-selected={index === active}
      aria-disabled={item.disabled || undefined}
      aria-keyshortcuts={shortcuts(item)}
      onmousedown={(event) => event.preventDefault()}
      onclick={() => onPick(index)}
    >
      {#if numbered}<kbd class="menu__number" class:menu__number--none={item.number === undefined} aria-hidden="true">{item.number ?? 0}</kbd>{/if}
      {#if item.avatar}<TeammateAvatar avatar={item.avatar.avatar} color={item.avatar.color} size={18} />{/if}
      <strong class="menu__title">{item.title}</strong>
      {#if item.hint}<span class="menu__hint">{item.hint}</span>{/if}
      {#if item.detail}<span class="menu__detail">{item.detail}</span>{/if}
      {#if item.note}<small class="menu__note">{item.note}</small>{/if}
      {#if item.badge}<small class="menu__badge">{item.badge}</small>{/if}
      {#if item.accelerator}<kbd class="menu__key" aria-hidden="true">{item.accelerator}</kbd>{/if}
    </button>
  {:else}
    <p class="menu__empty" role="status">
      {#if loading}<Spinner size={12} />{/if}
      {emptyText}
    </p>
  {/each}
</div>

<style>
  .menu {
    position: absolute;
    right: 0;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: var(--piui-z-dropdown);
    display: grid;
    /* Until the menu is measured: the real limit is the room above the field. */
    max-height: min(320px, 45vh);
    padding: 4px;
    overflow-y: auto;
    overscroll-behavior: contain;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-md);
    background: var(--piui-surface-1);
    box-shadow: var(--piui-shadow-2);
  }
  .menu--below {
    top: calc(100% + 6px);
    bottom: auto;
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: var(--piui-space-3);
    min-width: 0;
    padding: 8px 10px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text);
    text-align: left;
  }
  .menu button[aria-selected='true'] {
    background: var(--piui-hover);
  }
  .menu button[aria-disabled='true'] {
    opacity: 0.5;
  }
  .menu__title {
    flex: none;
    max-width: 60%;
    overflow: hidden;
    font-weight: var(--piui-weight-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu__hint {
    flex: none;
    color: var(--piui-text-disabled);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
  }
  .menu__detail {
    overflow: hidden;
    color: var(--piui-text-muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu__note {
    margin-left: auto;
    color: var(--piui-text-disabled);
  }
  .menu__badge {
    flex: none;
    margin-left: auto;
    padding: 0 6px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-xs);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    white-space: nowrap;
  }
  .menu__note + .menu__badge {
    margin-left: 0;
  }
  .menu__number,
  .menu__key {
    display: inline-grid;
    flex: none;
    place-items: center;
    min-width: 20px;
    height: 20px;
    padding: 0 5px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-xs);
    color: var(--piui-text-muted);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
    line-height: 1;
    text-transform: uppercase;
  }
  .menu__number--none {
    visibility: hidden;
  }
  .menu__key {
    margin-left: auto;
  }
  .menu button[aria-selected='true'] .menu__number,
  .menu button[aria-selected='true'] .menu__key {
    border-color: var(--piui-accent);
    color: var(--piui-accent);
  }
  .menu__group {
    padding: 6px 10px 2px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .menu__empty {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    padding: 8px 10px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
</style>
