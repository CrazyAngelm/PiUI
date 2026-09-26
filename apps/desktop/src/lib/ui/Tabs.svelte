<script lang="ts" generics="T extends string">
  import { Tabs } from 'bits-ui';
  import type { Snippet } from 'svelte';

  interface Tab {
    value: T;
    label: string;
    count?: number;
    disabled?: boolean;
  }
  interface Props {
    value: T;
    tabs: readonly Tab[];
    label: string;
    /** Renders the panel for the active tab. */
    panel: Snippet<[T]>;
    trailing?: Snippet;
    onValueChange?: (value: T) => void;
  }
  let { value = $bindable(), tabs, label, panel, trailing, onValueChange }: Props = $props();
</script>

<Tabs.Root
  {value}
  onValueChange={(next) => {
    value = next as T;
    onValueChange?.(value);
  }}
  class="piui-tabs"
>
  <div class="piui-tabs__bar">
    <Tabs.List class="piui-tabs__list" aria-label={label}>
      {#each tabs as tab (tab.value)}
        <Tabs.Trigger value={tab.value} disabled={tab.disabled} class="piui-tabs__trigger">
          {tab.label}
          {#if tab.count !== undefined}<span class="piui-tabs__count">{tab.count}</span>{/if}
        </Tabs.Trigger>
      {/each}
    </Tabs.List>
    {#if trailing}{@render trailing()}{/if}
  </div>
  {#each tabs as tab (tab.value)}
    <Tabs.Content value={tab.value} class="piui-tabs__panel">
      {#if tab.value === value}{@render panel(tab.value)}{/if}
    </Tabs.Content>
  {/each}
</Tabs.Root>

<style>
  :global(.piui-tabs) {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .piui-tabs__bar {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    border-bottom: 1px solid var(--piui-border-subtle);
  }
  :global(.piui-tabs__list) {
    display: flex;
    flex: 1;
    gap: var(--piui-space-1);
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  :global(.piui-tabs__trigger) {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 34px;
    padding: 0 var(--piui-space-2);
    border: 0;
    background: transparent;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-md);
    font-weight: var(--piui-weight-medium);
    white-space: nowrap;
  }
  :global(.piui-tabs__trigger:hover:not([data-disabled])) {
    color: var(--piui-text);
  }
  :global(.piui-tabs__trigger[data-state='active']) {
    color: var(--piui-text);
  }
  :global(.piui-tabs__trigger[data-state='active'])::after {
    content: '';
    position: absolute;
    right: var(--piui-space-2);
    bottom: -1px;
    left: var(--piui-space-2);
    height: 2px;
    border-radius: 2px;
    background: var(--piui-accent);
  }
  .piui-tabs__count {
    padding: 0 5px;
    border-radius: var(--piui-radius-full);
    background: var(--piui-surface-2);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    line-height: 16px;
  }
  :global(.piui-tabs__panel) {
    min-height: 0;
    outline: none;
  }
  :global(.piui-tabs__panel[data-state='inactive']) {
    display: none;
  }
</style>
