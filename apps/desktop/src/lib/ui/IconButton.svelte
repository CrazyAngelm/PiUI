<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Tooltip from './Tooltip.svelte';

  interface Props extends HTMLButtonAttributes {
    /** Accessible name; also shown as tooltip unless `tooltip={false}`. */
    label: string;
    shortcut?: string;
    tooltip?: boolean;
    size?: 'sm' | 'md' | 'lg';
    variant?: 'ghost' | 'subtle' | 'primary';
    active?: boolean;
    ref?: HTMLButtonElement | null;
    children: Snippet;
  }

  let {
    label,
    shortcut,
    tooltip = true,
    size = 'md',
    variant = 'ghost',
    active = false,
    ref = $bindable(null),
    children,
    type = 'button',
    class: className = '',
    ...rest
  }: Props = $props();
</script>

{#snippet button(props: Record<string, unknown> = {})}
  <button
    bind:this={ref}
    {type}
    class="icon-btn icon-btn--{size} icon-btn--{variant} {className}"
    class:icon-btn--active={active}
    aria-label={label}
    aria-pressed={active || undefined}
    {...props}
    {...rest}
  >
    {@render children()}
  </button>
{/snippet}

{#if tooltip}
  <Tooltip content={label} {shortcut}>
    {#snippet trigger(props)}
      {@render button(props)}
    {/snippet}
  </Tooltip>
{:else}
  {@render button()}
{/if}

<style>
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: var(--piui-control-md);
    height: var(--piui-control-md);
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
    transition:
      background-color var(--piui-duration-fast) var(--piui-ease-out),
      color var(--piui-duration-fast) var(--piui-ease-out);
  }
  .icon-btn :global(svg) {
    width: 16px;
    height: 16px;
  }
  .icon-btn--sm {
    width: var(--piui-control-sm);
    height: var(--piui-control-sm);
  }
  .icon-btn--sm :global(svg) {
    width: 14px;
    height: 14px;
  }
  .icon-btn--lg {
    width: var(--piui-control-lg);
    height: var(--piui-control-lg);
  }
  .icon-btn:hover:not(:disabled) {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .icon-btn--subtle {
    background: var(--piui-hover);
  }
  .icon-btn--primary {
    background: var(--piui-action);
    color: var(--piui-action-ink);
  }
  .icon-btn--primary:hover:not(:disabled) {
    background: var(--piui-action-hover);
    color: var(--piui-action-ink);
  }
  .icon-btn--active {
    background: var(--piui-selected);
    color: var(--piui-text);
  }
  .icon-btn:disabled {
    opacity: 0.45;
  }
</style>
