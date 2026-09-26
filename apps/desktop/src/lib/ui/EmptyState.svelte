<script lang="ts">
  import type { Component, Snippet } from 'svelte';

  interface Props {
    title: string;
    description?: string;
    icon?: Component<{ size?: number; strokeWidth?: number }>;
    size?: 'sm' | 'md';
    actions?: Snippet;
  }
  let { title, description, icon: Icon, size = 'md', actions }: Props = $props();
</script>

<div class="empty empty--{size}">
  {#if Icon}<span class="empty__icon"><Icon size={size === 'sm' ? 18 : 22} strokeWidth={1.6} /></span>{/if}
  <p class="empty__title">{title}</p>
  {#if description}<p class="empty__desc">{description}</p>{/if}
  {#if actions}<div class="empty__actions">{@render actions()}</div>{/if}
</div>

<style>
  .empty {
    display: grid;
    justify-items: center;
    gap: var(--piui-space-2);
    padding: var(--piui-space-8) var(--piui-space-4);
    color: var(--piui-text-muted);
    text-align: center;
  }
  .empty--sm {
    padding: var(--piui-space-6) var(--piui-space-3);
  }
  .empty__icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    margin-bottom: var(--piui-space-1);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-surface-1);
    color: var(--piui-text-muted);
  }
  .empty--sm .empty__icon {
    width: 32px;
    height: 32px;
  }
  .empty__title {
    margin: 0;
    color: var(--piui-text);
    font-size: var(--piui-text-lg);
    font-weight: var(--piui-weight-semibold);
  }
  .empty__desc {
    max-width: 44ch;
    margin: 0;
    line-height: var(--piui-leading-normal);
  }
  .empty__actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--piui-space-2);
    margin-top: var(--piui-space-2);
  }
</style>
