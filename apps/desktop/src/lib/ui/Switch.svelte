<script lang="ts">
  import { Switch } from 'bits-ui';

  interface Props {
    checked?: boolean;
    disabled?: boolean;
    label: string;
    /** Visually hide the label; it stays the accessible name. */
    hideLabel?: boolean;
    id?: string;
    onCheckedChange?: (checked: boolean) => void;
  }
  let {
    checked = $bindable(false),
    disabled = false,
    label,
    hideLabel = false,
    id,
    onCheckedChange,
  }: Props = $props();
</script>

<label class="switch" class:switch--disabled={disabled}>
  <Switch.Root
    bind:checked
    {disabled}
    {id}
    {onCheckedChange}
    class="piui-switch"
    aria-label={hideLabel ? label : undefined}
  >
    <Switch.Thumb class="piui-switch__thumb" />
  </Switch.Root>
  {#if !hideLabel}<span>{label}</span>{/if}
</label>

<style>
  .switch {
    display: inline-flex;
    align-items: center;
    gap: var(--piui-space-2);
    color: var(--piui-text);
    font-size: var(--piui-text-md);
    cursor: pointer;
  }
  .switch--disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  :global(.piui-switch) {
    position: relative;
    display: inline-flex;
    align-items: center;
    flex: none;
    width: 30px;
    height: 18px;
    padding: 2px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-full);
    background: var(--piui-surface-2);
    transition: background-color var(--piui-duration-fast) var(--piui-ease-out);
  }
  :global(.piui-switch[data-state='checked']) {
    border-color: transparent;
    background: var(--piui-action);
  }
  :global(.piui-switch__thumb) {
    display: block;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--piui-text);
    transition: transform var(--piui-duration-fast) var(--piui-ease-out);
  }
  :global(.piui-switch__thumb[data-state='checked']) {
    transform: translateX(12px);
    background: var(--piui-action-ink);
  }
</style>
