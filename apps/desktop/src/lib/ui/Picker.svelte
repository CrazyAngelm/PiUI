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
  import { Command, Popover } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import Check from '@lucide/svelte/icons/check';
  import Search from '@lucide/svelte/icons/search';

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
    onSelect,
  }: Props = $props();

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
      {align}
      {side}
      sideOffset={6}
      collisionPadding={8}
      style="width: {width}px"
    >
      <Command.Root label={label} loop>
        <div class="piui-picker__search">
          <Search size={14} />
          <Command.Input class="piui-picker__input" placeholder={searchPlaceholder} aria-label={searchPlaceholder} />
        </div>
        <Command.List class="piui-picker__list">
          <Command.Viewport>
            <Command.Empty class="piui-picker__empty">{emptyText}</Command.Empty>
            {#each groups as [group, groupItems] (group)}
              <Command.Group>
                {#if group}<Command.GroupHeading class="piui-picker__heading">{group}</Command.GroupHeading>{/if}
                <Command.GroupItems>
                  {#each groupItems as item (item.value)}
                    <Command.Item
                      class="piui-picker__item"
                      value={`${item.group ?? ''}\u0000${item.value}`}
                      keywords={[item.label, item.value, ...(item.keywords ?? [])]}
                      disabled={item.disabled}
                      onSelect={() => choose(item)}
                    >
                      <span class="piui-picker__check">
                        {#if item.value === value}<Check size={14} />{/if}
                      </span>
                      <span class="piui-picker__main">
                        <span class="piui-picker__label">{item.label}</span>
                        {#if item.disabled && item.disabledReason}
                          <span class="piui-picker__desc">{item.disabledReason}</span>
                        {:else if item.description}
                          <span class="piui-picker__desc">{item.description}</span>
                        {/if}
                      </span>
                      {#each item.badges ?? [] as badge (badge)}
                        <span class="piui-picker__badge">{badge}</span>
                      {/each}
                    </Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/each}
          </Command.Viewport>
        </Command.List>
      </Command.Root>
      {#if footer}<div class="piui-picker__footer">{@render footer()}</div>{/if}
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
  :global(.piui-picker [data-command-root]) {
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
  :global(.piui-picker__input) {
    flex: 1;
    height: 36px;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--piui-text);
  }
  :global(.piui-picker__input::placeholder) {
    color: var(--piui-text-disabled);
  }
  :global(.piui-picker__list) {
    min-height: 0;
    padding: 4px;
    overflow-y: auto;
  }
  :global(.piui-picker__empty) {
    padding: var(--piui-space-4);
    color: var(--piui-text-muted);
    text-align: center;
  }
  :global(.piui-picker__heading) {
    padding: 8px 8px 4px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  :global(.piui-picker__item) {
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
  :global(.piui-picker__item[data-selected]) {
    background: var(--piui-hover);
  }
  :global(.piui-picker__item[data-disabled]) {
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
</style>
