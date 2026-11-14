<script lang="ts" module>
  export interface PickerItem<T extends string = string> {
    value: T;
    label: string;
    description?: string;
    group?: string;
    keywords?: string[];
    badges?: string[];
    disabled?: boolean;
    /** Shown instead of the description when disabled, e.g. why a model is unavailable. */
    disabledReason?: string;
  }
</script>

<script lang="ts" generics="T extends string">
  import { Popover } from 'bits-ui';
  import { untrack, type Snippet } from 'svelte';
  import { LazyPanel } from './lazyPanel.svelte';
  import LazyPanelStatus from './LazyPanelStatus.svelte';

  interface Props {
    items: readonly PickerItem<T>[];
    value?: T;
    open?: boolean;
    label: string;
    searchPlaceholder?: string;
    emptyText?: string;
    width?: number;
    align?: 'start' | 'center' | 'end';
    side?: 'top' | 'bottom';
    trigger: Snippet<[Record<string, unknown>]>;
    /** Optional content under the list, e.g. reasoning controls. */
    footer?: Snippet;
    /** Optional content between the search and the list, e.g. tabs. `focusSearch` returns the focus to the search field. */
    header?: Snippet<[{ focusSearch: () => void }]>;
    /** The search text; reset to empty whenever the picker closes. */
    search?: string;
    /** Keys pressed in the search field. */
    onSearchKeydown?: (event: KeyboardEvent) => void;
    onSelect: (value: T) => void;
  }

  let {
    items,
    value,
    open = $bindable(false),
    label,
    searchPlaceholder = 'Search…',
    emptyText = 'Nothing found',
    width = 320,
    align = 'start',
    side = 'bottom',
    trigger,
    footer,
    header,
    search = $bindable(''),
    onSearchKeydown,
    onSelect,
  }: Props = $props();

  const panel = new LazyPanel(() => import('./PickerPanel.svelte'));
  $effect(() => { if (open) untrack(() => { void panel.load(); }); });

  let searchField = $state<HTMLInputElement | null>(null);
  const focusSearch = (): void => searchField?.focus();

  // The popover content unmounts on close, so the field starts empty: the bound text follows.
  $effect(() => {
    if (!open) search = '';
  });

  /** Enter on a header control acts on that control, not on the highlighted row. */
  function headerKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') event.stopPropagation();
  }

  const groups = $derived.by(() => {
    const byGroup = new Map<string, PickerItem<T>[]>();
    for (const item of items) {
      const key = item.group ?? '';
      const list = byGroup.get(key) ?? [];
      list.push(item);
      byGroup.set(key, list);
    }
    return [...byGroup.entries()];
  });

  function choose(item: PickerItem<T>): void {
    if (item.disabled) return;
    onSelect(item.value);
    open = false;
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      {@render trigger(props)}
    {/snippet}
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content
      class="piui-picker"
      onOpenAutoFocus={(event) => { if (!panel.component) event.preventDefault(); }}
      {align}
      {side}
      sideOffset={6}
      collisionPadding={8}
      style="width: {width}px"
    >
      {#if panel.component}
        {@const Panel = panel.component}
        <Panel {groups} {value} {label} {searchPlaceholder} {emptyText} {header} {footer}
          bind:search bind:searchField {focusSearch} {headerKeydown} {onSearchKeydown} onChoose={choose} />
      {:else}
        <LazyPanelStatus failed={panel.failed} {label} retry={() => void panel.load()} />
      {/if}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>


<style>
  :global(.piui-picker) {
    z-index: var(--piui-z-dropdown);
    display: flex;
    flex-direction: column;
    max-width: calc(100vw - 16px);
    max-height: min(480px, var(--bits-popover-content-available-height, 70vh));
    overflow: hidden;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-md);
    background: var(--piui-surface-1);
    color: var(--piui-text);
    box-shadow: var(--piui-shadow-2);
    outline: none;
    animation: piui-pop-in var(--piui-duration-fast) var(--piui-ease-out);
  }
  /* Keep panel styles eager: Vite does not retry failed dynamic CSS links. */
  :global {


  .piui-picker [data-command-root] {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .piui-picker__search {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    padding: 0 var(--piui-space-3);
    border-bottom: 1px solid var(--piui-border-subtle);
    color: var(--piui-text-muted);
  }
  .piui-picker__header {
    display: flex;
    padding: var(--piui-space-2) var(--piui-space-3) 0;
  }
  .piui-picker__input {
    flex: 1;
    height: 36px;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--piui-text);
  }
  /* The open popover always focuses its search: the global ring would be noise, and
     `overflow: hidden` clips its offset. */
  .piui-picker__input:focus-visible {
    outline: none;
  }
  .piui-picker__input::placeholder {
    color: var(--piui-text-disabled);
  }
  .piui-picker__list {
    min-height: 0;
    padding: 4px;
    overflow-y: auto;
  }
  .piui-picker__empty {
    padding: var(--piui-space-4);
    color: var(--piui-text-muted);
    text-align: center;
  }
  .piui-picker__heading {
    padding: 8px 8px 4px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .piui-picker__item {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    min-height: 32px;
    padding: 5px var(--piui-space-2);
    border-radius: var(--piui-radius-sm);
    cursor: default;
    outline: none;
    user-select: none;
  }
  .piui-picker__item[data-selected] {
    background: var(--piui-hover);
  }
  .piui-picker__item[data-disabled] {
    opacity: 0.5;
  }
  .piui-picker__check {
    display: inline-flex;
    justify-content: center;
    flex: none;
    width: 16px;
    color: var(--piui-accent);
  }
  .piui-picker__main {
    display: grid;
    flex: 1;
    min-width: 0;
  }
  .piui-picker__label,
  .piui-picker__desc {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .piui-picker__desc {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .piui-picker__badge {
    flex: none;
    padding: 0 5px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-full);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    line-height: 16px;
  }
  .piui-picker__footer {
    padding: var(--piui-space-2) var(--piui-space-3);
    border-top: 1px solid var(--piui-border-subtle);
  }

  }
</style>
