<script lang="ts">
  import { ContextMenu } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import Check from '@lucide/svelte/icons/check';
  import Kbd from './Kbd.svelte';
  import type { MenuEntry } from './Menu.svelte';

  interface Props {
    items: readonly MenuEntry[];
    /** The element the menu belongs to; receives props that must be spread onto it. */
    target: Snippet<[Record<string, unknown>]>;
    minWidth?: number;
  }
  let { items, target, minWidth = 200 }: Props = $props();
</script>

<ContextMenu.Root>
  <ContextMenu.Trigger>
    {#snippet child({ props })}
      {@render target(props)}
    {/snippet}
  </ContextMenu.Trigger>
  <ContextMenu.Portal>
    <ContextMenu.Content class="piui-menu" collisionPadding={8} style="min-width: {minWidth}px">
      {#each items as entry, index (index)}
        {#if entry.type === 'separator'}
          <ContextMenu.Separator class="piui-menu__separator" />
        {:else if entry.type === 'label'}
          <div class="menu-label">{entry.label}</div>
        {:else}
          <ContextMenu.Item
            class="piui-menu__item{entry.danger ? ' piui-menu__item--danger' : ''}"
            disabled={entry.disabled}
            textValue={entry.label}
            onSelect={entry.onSelect}
          >
            <span class="menu-icon">
              {#if entry.checked}
                <Check size={14} />
              {:else if entry.icon}
                <entry.icon size={14} />
              {/if}
            </span>
            <span class="menu-text">{entry.label}</span>
            {#if entry.shortcut}<Kbd keys={entry.shortcut} />{/if}
          </ContextMenu.Item>
        {/if}
      {/each}
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>

<style>
  .menu-icon {
    display: inline-flex;
    justify-content: center;
    width: 16px;
    color: var(--piui-text-muted);
  }
  .menu-text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu-label {
    padding: 6px var(--piui-space-2) 2px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
</style>
