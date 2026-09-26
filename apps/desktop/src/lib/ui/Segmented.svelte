<script lang="ts" generics="T extends string">
  import { ToggleGroup } from 'bits-ui';
  import type { Component } from 'svelte';

  interface Option {
    value: T;
    label: string;
    icon?: Component<{ size?: number }>;
    disabled?: boolean;
    title?: string;
  }
  interface Props {
    value: T;
    options: readonly Option[];
    label: string;
    size?: 'sm' | 'md';
    iconOnly?: boolean;
    onValueChange?: (value: T) => void;
  }
  let { value = $bindable(), options, label, size = 'md', iconOnly = false, onValueChange }: Props = $props();

  function change(next: string): void {
    // A single-select segmented control never becomes empty.
    if (next === '' || next === value) return;
    value = next as T;
    onValueChange?.(value);
  }
</script>

<ToggleGroup.Root type="single" {value} onValueChange={change} class="piui-seg piui-seg--{size}" aria-label={label}>
  {#each options as option (option.value)}
    <ToggleGroup.Item
      value={option.value}
      disabled={option.disabled}
      class="piui-seg__item"
      aria-label={iconOnly ? option.label : undefined}
      title={option.title ?? (iconOnly ? option.label : undefined)}
    >
      {#if option.icon}<option.icon size={14} />{/if}
      {#if !iconOnly}<span>{option.label}</span>{/if}
    </ToggleGroup.Item>
  {/each}
</ToggleGroup.Root>

<style>
  :global(.piui-seg) {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg-sunken);
  }
  :global(.piui-seg__item) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: calc(var(--piui-control-md) - 6px);
    padding: 0 var(--piui-space-3);
    border: 0;
    border-radius: calc(var(--piui-radius-sm) - 2px);
    background: transparent;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-medium);
    white-space: nowrap;
    transition:
      background-color var(--piui-duration-fast) var(--piui-ease-out),
      color var(--piui-duration-fast) var(--piui-ease-out);
  }
  :global(.piui-seg--sm .piui-seg__item) {
    height: calc(var(--piui-control-sm) - 6px);
    padding: 0 var(--piui-space-2);
  }
  :global(.piui-seg__item:hover:not([data-disabled])) {
    color: var(--piui-text);
  }
  :global(.piui-seg__item[data-state='on']) {
    background: var(--piui-surface-2);
    color: var(--piui-text);
    box-shadow: var(--piui-shadow-1);
  }
  :global(.piui-seg__item[data-disabled]) {
    opacity: 0.45;
  }
</style>
