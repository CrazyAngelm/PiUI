<script lang="ts">
  import { Checkbox } from 'bits-ui';
  import Check from '@lucide/svelte/icons/check';
  import Minus from '@lucide/svelte/icons/minus';

  interface Props {
    checked?: boolean;
    indeterminate?: boolean;
    disabled?: boolean;
    label: string;
    description?: string;
    onCheckedChange?: (checked: boolean) => void;
  }
  let {
    checked = $bindable(false),
    indeterminate = $bindable(false),
    disabled = false,
    label,
    description,
    onCheckedChange,
  }: Props = $props();
</script>

<label class="check" class:check--disabled={disabled}>
  <Checkbox.Root bind:checked bind:indeterminate {disabled} {onCheckedChange} class="piui-check">
    {#snippet children({ checked: isChecked, indeterminate: isIndeterminate })}
      {#if isIndeterminate}
        <Minus size={12} strokeWidth={3} />
      {:else if isChecked}
        <Check size={12} strokeWidth={3} />
      {/if}
    {/snippet}
  </Checkbox.Root>
  <span class="check__text">
    <span>{label}</span>
    {#if description}<small>{description}</small>{/if}
  </span>
</label>

<style>
  .check {
    display: inline-flex;
    align-items: flex-start;
    gap: var(--piui-space-2);
    cursor: pointer;
  }
  .check--disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  :global(.piui-check) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 16px;
    height: 16px;
    margin-top: 1px;
    padding: 0;
    border: 1px solid var(--piui-border-strong);
    border-radius: var(--piui-radius-xs);
    background: var(--piui-bg-sunken);
    color: var(--piui-action-ink);
  }
  :global(.piui-check[data-state='checked']),
  :global(.piui-check[data-state='indeterminate']) {
    border-color: transparent;
    background: var(--piui-action);
  }
  .check__text {
    display: grid;
    gap: 2px;
  }
  .check__text small {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
</style>
