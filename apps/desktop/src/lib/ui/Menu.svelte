<script lang="ts" module>
  import type { Component } from 'svelte';

  export type MenuEntry =
    | {
        type?: 'item';
        label: string;
        icon?: Component<{ size?: number }>;
        shortcut?: string;
        danger?: boolean;
        disabled?: boolean;
        checked?: boolean;
        onSelect: () => void;
      }
    | { type: 'separator' }
    | { type: 'label'; label: string };
</script>

<script lang="ts">
  import { DropdownMenu } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import Check from '@lucide/svelte/icons/check';
  import Kbd from './Kbd.svelte';

  interface Props {
    items: readonly MenuEntry[];
    open?: boolean;
    align?: 'start' | 'center' | 'end';
    side?: 'top' | 'bottom' | 'left' | 'right';
    /** Trigger element; receives props that must be spread onto a button. */
    trigger: Snippet<[Record<string, unknown>]>;
    minWidth?: number;
  }
  let { items, open = $bindable(false), align = 'start', side = 'bottom', trigger, minWidth = 200 }: Props = $props();
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      {@render trigger(props)}
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      class="piui-menu"
      {align}
      {side}
      sideOffset={4}
      collisionPadding={8}
      style="min-width: {minWidth}px"
    >
      {#each items as entry, index (index)}
        {#if entry.type === 'separator'}
          <DropdownMenu.Separator class="piui-menu__separator" />
        {:else if entry.type === 'label'}
          <div class="piui-menu__label">{entry.label}</div>
        {:else}
          <DropdownMenu.Item
            class="piui-menu__item{entry.danger ? ' piui-menu__item--danger' : ''}"
            disabled={entry.disabled}
            textValue={entry.label}
            onSelect={entry.onSelect}
          >
            <span class="piui-menu__icon">
              {#if entry.checked}
                <Check size={14} />
              {:else if entry.icon}
                <entry.icon size={14} />
              {/if}
            </span>
            <span class="piui-menu__text">{entry.label}</span>
            {#if entry.shortcut}<Kbd keys={entry.shortcut} />{/if}
          </DropdownMenu.Item>
        {/if}
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>

<style>
  :global(.piui-menu) {
    z-index: var(--piui-z-dropdown);
    max-height: var(--bits-dropdown-menu-content-available-height, 60vh);
    padding: 4px;
    overflow-y: auto;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-md);
    background: var(--piui-surface-1);
    box-shadow: var(--piui-shadow-2);
    outline: none;
    animation: piui-pop-in var(--piui-duration-fast) var(--piui-ease-out);
  }
  :global(.piui-menu__item) {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    min-height: 30px;
    padding: 0 var(--piui-space-2);
    border-radius: var(--piui-radius-sm);
    color: var(--piui-text);
    font-size: var(--piui-text-md);
    cursor: default;
    outline: none;
    user-select: none;
  }
  :global(.piui-menu__item[data-highlighted]) {
    background: var(--piui-hover);
  }
  :global(.piui-menu__item[data-disabled]) {
    opacity: 0.45;
  }
  :global(.piui-menu__item--danger) {
    color: var(--piui-danger);
  }
  .piui-menu__icon {
    display: inline-flex;
    justify-content: center;
    width: 16px;
    color: var(--piui-text-muted);
  }
  .piui-menu__text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  :global(.piui-menu__separator) {
    height: 1px;
    margin: 4px 2px;
    background: var(--piui-border-subtle);
  }
  .piui-menu__label {
    padding: 6px var(--piui-space-2) 2px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
</style>
