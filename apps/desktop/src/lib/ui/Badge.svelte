<script lang="ts">
  import type { Snippet } from 'svelte';

  type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';
  interface Props {
    tone?: Tone;
    size?: 'sm' | 'md';
    title?: string;
    children: Snippet;
  }
  let { tone = 'neutral', size = 'sm', title, children }: Props = $props();
</script>

<span class="badge badge--{tone} badge--{size}" {title}>{@render children()}</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
    max-width: 100%;
    padding: 0 6px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-full);
    background: var(--piui-surface-1);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-medium);
    line-height: 18px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .badge--md {
    padding: 0 8px;
    font-size: var(--piui-text-sm);
    line-height: 22px;
  }
  .badge :global(svg) {
    width: 11px;
    height: 11px;
  }
  .badge--accent {
    border-color: transparent;
    background: var(--piui-accent-soft);
    color: var(--piui-accent);
  }
  .badge--success {
    border-color: var(--piui-success-border);
    background: var(--piui-success-surface);
    color: var(--piui-success-text);
  }
  .badge--warning {
    border-color: var(--piui-warning-border);
    background: var(--piui-warning-surface);
    color: var(--piui-warning-text);
  }
  .badge--danger {
    border-color: var(--piui-danger-border);
    background: var(--piui-danger-surface);
    color: var(--piui-danger-text);
  }
  .badge--info {
    border-color: var(--piui-info-border);
    background: var(--piui-info-surface);
    color: var(--piui-info-text);
  }
</style>
