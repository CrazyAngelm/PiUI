<script lang="ts">
  import { Tooltip } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import Kbd from './Kbd.svelte';

  interface Props {
    content: string;
    shortcut?: string;
    side?: 'top' | 'bottom' | 'left' | 'right';
    disabled?: boolean;
    /** Receives trigger props that must be spread onto the focusable element. */
    trigger: Snippet<[Record<string, unknown>]>;
  }

  let { content, shortcut, side = 'top', disabled = false, trigger }: Props = $props();
</script>

<Tooltip.Root {disabled}>
  <Tooltip.Trigger>
    {#snippet child({ props })}
      {@render trigger(props)}
    {/snippet}
  </Tooltip.Trigger>
  <Tooltip.Portal>
    <Tooltip.Content class="piui-tooltip" sideOffset={6} {side} collisionPadding={8}>
      <span>{content}</span>
      {#if shortcut}<Kbd keys={shortcut} tone="inverse" />{/if}
    </Tooltip.Content>
  </Tooltip.Portal>
</Tooltip.Root>

<style>
  :global(.piui-tooltip) {
    z-index: var(--piui-z-tooltip);
    display: inline-flex;
    align-items: center;
    gap: var(--piui-space-2);
    max-width: 320px;
    padding: 5px 8px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-surface-3);
    color: var(--piui-text);
    box-shadow: var(--piui-shadow-2);
    font-size: var(--piui-text-sm);
    line-height: var(--piui-leading-tight);
    animation: piui-fade-in var(--piui-duration-fast) var(--piui-ease-out);
  }
</style>
