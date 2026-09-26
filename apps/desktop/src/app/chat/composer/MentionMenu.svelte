<script lang="ts">
  import { Spinner } from '../../../lib/ui';
  import type { ComposerMenuItem } from './menuItems';

  interface Props {
    /** DOM id; option ids are `${id}-${index}` for aria-activedescendant. */
    id: string;
    label: string;
    items: readonly ComposerMenuItem[];
    active: number;
    loading?: boolean;
    /** Shown when there is nothing to pick. */
    emptyText?: string;
    onPick: (index: number) => void;
  }
  let { id, label, items, active, loading = false, emptyText = '', onPick }: Props = $props();
</script>

<div class="menu" {id} role="listbox" aria-label={label} aria-busy={loading || undefined}>
  {#each items as item, index (item.key)}
    <button
      type="button"
      id={`${id}-${index}`}
      role="option"
      tabindex="-1"
      aria-selected={index === active}
      aria-disabled={item.disabled || undefined}
      onmousedown={(event) => event.preventDefault()}
      onclick={() => onPick(index)}
    >
      <strong class="menu__title">{item.title}</strong>
      {#if item.hint}<span class="menu__hint">{item.hint}</span>{/if}
      {#if item.detail}<span class="menu__detail">{item.detail}</span>{/if}
      {#if item.note}<small class="menu__note">{item.note}</small>{/if}
      {#if item.badge}<small class="menu__badge">{item.badge}</small>{/if}
    </button>
  {:else}
    <p class="menu__empty" role="status">
      {#if loading}<Spinner size={12} />{/if}
      {emptyText}
    </p>
  {/each}
</div>

<style>
  .menu {
    position: absolute;
    right: 0;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: var(--piui-z-dropdown);
    display: grid;
    max-height: min(320px, 45vh);
    padding: 4px;
    overflow-y: auto;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-md);
    background: var(--piui-surface-1);
    box-shadow: var(--piui-shadow-2);
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: var(--piui-space-3);
    min-width: 0;
    padding: 8px 10px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text);
    text-align: left;
  }
  .menu button[aria-selected='true'] {
    background: var(--piui-hover);
  }
  .menu button[aria-disabled='true'] {
    opacity: 0.5;
  }
  .menu__title {
    flex: none;
    max-width: 60%;
    overflow: hidden;
    font-weight: var(--piui-weight-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu__hint {
    flex: none;
    color: var(--piui-text-disabled);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
  }
  .menu__detail {
    overflow: hidden;
    color: var(--piui-text-muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu__note {
    margin-left: auto;
    color: var(--piui-text-disabled);
  }
  .menu__badge {
    flex: none;
    margin-left: auto;
    padding: 0 6px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-xs);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    white-space: nowrap;
  }
  .menu__note + .menu__badge {
    margin-left: 0;
  }
  .menu__empty {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    padding: 8px 10px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
</style>
