<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Spinner from './Spinner.svelte';

  type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
  type Size = 'sm' | 'md' | 'lg';

  interface Props extends HTMLButtonAttributes {
    variant?: Variant;
    size?: Size;
    loading?: boolean;
    block?: boolean;
    ref?: HTMLButtonElement | null;
    leading?: Snippet;
    trailing?: Snippet;
    children?: Snippet;
  }

  let {
    variant = 'secondary',
    size = 'md',
    loading = false,
    block = false,
    ref = $bindable(null),
    leading,
    trailing,
    children,
    disabled,
    type = 'button',
    class: className = '',
    ...rest
  }: Props = $props();
</script>

<button
  bind:this={ref}
  {type}
  class="btn btn--{variant} btn--{size} {className}"
  class:btn--block={block}
  disabled={disabled || loading}
  aria-busy={loading || undefined}
  {...rest}
>
  {#if loading}
    <Spinner size={size === 'sm' ? 12 : 14} />
  {:else if leading}
    <span class="btn__icon">{@render leading()}</span>
  {/if}
  {#if children}<span class="btn__label">{@render children()}</span>{/if}
  {#if trailing}<span class="btn__icon btn__icon--trailing">{@render trailing()}</span>{/if}
</button>

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--piui-space-2);
    height: var(--piui-control-md);
    padding: 0 var(--piui-space-3);
    border: 1px solid transparent;
    border-radius: var(--piui-radius-sm);
    font-size: var(--piui-text-md);
    font-weight: var(--piui-weight-medium);
    line-height: 1;
    white-space: nowrap;
    user-select: none;
    transition:
      background-color var(--piui-duration-fast) var(--piui-ease-out),
      border-color var(--piui-duration-fast) var(--piui-ease-out),
      color var(--piui-duration-fast) var(--piui-ease-out),
      transform var(--piui-duration-fast) var(--piui-ease-out);
  }
  .btn:active:not(:disabled) {
    transform: translateY(1px);
  }
  .btn:disabled {
    opacity: 0.5;
  }
  .btn--block {
    width: 100%;
  }
  .btn--sm {
    height: var(--piui-control-sm);
    padding: 0 var(--piui-space-2);
    font-size: var(--piui-text-sm);
    gap: 6px;
  }
  .btn--lg {
    height: var(--piui-control-lg);
    padding: 0 var(--piui-space-4);
    font-size: var(--piui-text-lg);
  }
  .btn--primary {
    background: var(--piui-action);
    color: var(--piui-action-ink);
  }
  .btn--primary:hover:not(:disabled) {
    background: var(--piui-action-hover);
  }
  .btn--primary:active:not(:disabled) {
    background: var(--piui-action-pressed);
  }
  .btn--secondary {
    background: var(--piui-surface-1);
    border-color: var(--piui-border);
    color: var(--piui-text);
  }
  .btn--secondary:hover:not(:disabled) {
    background: var(--piui-surface-2);
  }
  .btn--ghost {
    background: transparent;
    color: var(--piui-text-muted);
  }
  .btn--ghost:hover:not(:disabled) {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .btn--subtle {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .btn--subtle:hover:not(:disabled) {
    background: var(--piui-pressed);
  }
  .btn--danger {
    background: var(--piui-danger-surface);
    border-color: var(--piui-danger-border);
    color: var(--piui-danger-text);
  }
  .btn--danger:hover:not(:disabled) {
    background: var(--piui-danger-border);
  }
  .btn__label {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .btn__icon {
    display: inline-flex;
    flex: none;
  }
  .btn__icon :global(svg) {
    width: 15px;
    height: 15px;
  }
  .btn--sm .btn__icon :global(svg) {
    width: 13px;
    height: 13px;
  }
</style>
