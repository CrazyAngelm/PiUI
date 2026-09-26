<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    label: string;
    /** Id of the control this label describes. */
    for?: string;
    description?: string;
    error?: string;
    optionalLabel?: string;
    action?: Snippet;
    children: Snippet;
  }
  let { label, for: htmlFor, description, error, optionalLabel, action, children }: Props = $props();
</script>

<div class="field">
  <div class="field__head">
    <label for={htmlFor}>
      {label}
      {#if optionalLabel}<span class="field__optional">{optionalLabel}</span>{/if}
    </label>
    {#if action}{@render action()}{/if}
  </div>
  {@render children()}
  {#if error}
    <p class="field__error" role="alert">{error}</p>
  {:else if description}
    <p class="field__hint">{description}</p>
  {/if}
</div>

<style>
  .field {
    display: grid;
    gap: 6px;
  }
  .field__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--piui-space-2);
  }
  label {
    color: var(--piui-text);
    font-size: var(--piui-text-sm);
    font-weight: var(--piui-weight-medium);
  }
  .field__optional {
    margin-left: 4px;
    color: var(--piui-text-faint);
    font-weight: var(--piui-weight-regular);
  }
  .field__hint,
  .field__error {
    margin: 0;
    font-size: var(--piui-text-sm);
    line-height: var(--piui-leading-normal);
  }
  .field__hint {
    color: var(--piui-text-muted);
  }
  .field__error {
    color: var(--piui-danger);
  }
</style>
