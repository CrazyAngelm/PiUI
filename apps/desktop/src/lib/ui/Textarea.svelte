<script lang="ts">
  import type { HTMLTextareaAttributes } from 'svelte/elements';

  interface Props extends HTMLTextareaAttributes {
    value?: string;
    invalid?: boolean;
    /** Grow with content up to maxRows, then scroll. */
    autoGrow?: boolean;
    minRows?: number;
    maxRows?: number;
    ref?: HTMLTextAreaElement | null;
  }

  let {
    value = $bindable(''),
    invalid = false,
    autoGrow = true,
    minRows = 3,
    maxRows = 16,
    ref = $bindable(null),
    class: className = '',
    ...rest
  }: Props = $props();

  $effect(() => {
    void value;
    if (!autoGrow || ref === null) return;
    const style = getComputedStyle(ref);
    const line = parseFloat(style.lineHeight) || 20;
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    ref.style.height = 'auto';
    const min = minRows * line + padding;
    const max = maxRows * line + padding;
    ref.style.height = `${Math.min(Math.max(ref.scrollHeight, min), max)}px`;
  });
</script>

<textarea
  bind:this={ref}
  bind:value
  class="textarea {className}"
  class:textarea--invalid={invalid}
  aria-invalid={invalid || undefined}
  rows={minRows}
  {...rest}
></textarea>

<style>
  .textarea {
    display: block;
    width: 100%;
    padding: var(--piui-space-2) var(--piui-space-3);
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-bg-sunken);
    color: var(--piui-text);
    line-height: var(--piui-leading-normal);
    resize: vertical;
  }
  .textarea:hover {
    border-color: var(--piui-border-strong);
  }
  .textarea:focus-visible {
    outline: none;
    border-color: var(--piui-focus);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--piui-focus) 18%, transparent);
  }
  .textarea::placeholder {
    color: var(--piui-text-disabled);
  }
  .textarea--invalid {
    border-color: var(--piui-danger);
  }
</style>
