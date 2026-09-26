<script lang="ts">
  import { Popover } from 'bits-ui';
  import type { Snippet } from 'svelte';

  interface Props {
    open?: boolean;
    align?: 'start' | 'center' | 'end';
    side?: 'top' | 'bottom' | 'left' | 'right';
    width?: number | string;
    padded?: boolean;
    label?: string;
    trigger: Snippet<[Record<string, unknown>]>;
    children: Snippet;
    onOpenChange?: (open: boolean) => void;
  }
  let {
    open = $bindable(false),
    align = 'start',
    side = 'bottom',
    width = 320,
    padded = true,
    label,
    trigger,
    children,
    onOpenChange,
  }: Props = $props();
</script>

<Popover.Root bind:open {onOpenChange}>
  <Popover.Trigger>
    {#snippet child({ props })}
      {@render trigger(props)}
    {/snippet}
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content
      class="piui-popover{padded ? ' piui-popover--padded' : ''}"
      {align}
      {side}
      sideOffset={6}
      collisionPadding={8}
      role="dialog"
      aria-label={label}
      style="width: {typeof width === 'number' ? `${width}px` : width}"
    >
      {@render children()}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>

<style>
  :global(.piui-popover) {
    z-index: var(--piui-z-dropdown);
    max-width: calc(100vw - 16px);
    max-height: var(--bits-popover-content-available-height, 70vh);
    overflow: auto;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-md);
    background: var(--piui-surface-1);
    color: var(--piui-text);
    box-shadow: var(--piui-shadow-2);
    outline: none;
    animation: piui-pop-in var(--piui-duration-fast) var(--piui-ease-out);
  }
  :global(.piui-popover--padded) {
    padding: var(--piui-space-3);
  }
</style>
