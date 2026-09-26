<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLInputAttributes } from 'svelte/elements';

  interface Props extends Omit<HTMLInputAttributes, 'size'> {
    value?: string;
    size?: 'sm' | 'md' | 'lg';
    invalid?: boolean;
    ref?: HTMLInputElement | null;
    leading?: Snippet;
    trailing?: Snippet;
  }

  let {
    value = $bindable(''),
    size = 'md',
    invalid = false,
    ref = $bindable(null),
    leading,
    trailing,
    class: className = '',
    ...rest
  }: Props = $props();
</script>

<span class="input input--{size} {className}" class:input--invalid={invalid}>
  {#if leading}<span class="input__adorn">{@render leading()}</span>{/if}
  <input bind:this={ref} bind:value aria-invalid={invalid || undefined} {...rest} />
  {#if trailing}<span class="input__adorn">{@render trailing()}</span>{/if}
</span>

<style>
  .input {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    height: var(--piui-control-md);
    padding: 0 var(--piui-space-3);
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg-sunken);
    color: var(--piui-text);
    transition: border-color var(--piui-duration-fast) var(--piui-ease-out);
  }
  .input:hover {
    border-color: var(--piui-border-strong);
  }
  .input:focus-within {
    border-color: var(--piui-focus);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--piui-focus) 18%, transparent);
  }
  .input--invalid {
    border-color: var(--piui-danger);
  }
  .input--sm {
    height: var(--piui-control-sm);
    padding: 0 var(--piui-space-2);
    font-size: var(--piui-text-sm);
  }
  .input--lg {
    height: var(--piui-control-lg);
    font-size: var(--piui-text-lg);
  }
  input {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: 0;
    outline: none;
    background: transparent;
    color: inherit;
  }
  input::placeholder {
    color: var(--piui-text-disabled);
  }
  input:focus-visible {
    outline: none;
  }
  .input__adorn {
    display: inline-flex;
    flex: none;
    color: var(--piui-text-muted);
  }
  .input__adorn :global(svg) {
    width: 14px;
    height: 14px;
  }
</style>
