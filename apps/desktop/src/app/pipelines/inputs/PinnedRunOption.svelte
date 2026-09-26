<script lang="ts">
  import Pin from '@lucide/svelte/icons/pin';
  import { t } from '../../../features/locale/language';
  import { Checkbox } from '../../../lib/ui';

  /**
   * The Start dialog's explicit choice (orchestration v6.3): with it, pinned
   * steps do not run and their pinned output goes to the next steps; without
   * it every step runs. Shown only when the pipeline has pinned steps.
   */
  interface Props {
    checked: boolean;
    /** Names of the pinned steps. */
    steps: readonly string[];
    disabled?: boolean;
  }
  let { checked = $bindable(true), steps, disabled = false }: Props = $props();
</script>

{#if steps.length}
  <div class="option">
    <span class="mark" aria-hidden="true"><Pin size={14} /></span>
    <Checkbox
      bind:checked
      {disabled}
      label={$t('Use pinned data (pinned steps don’t run)')}
      description={checked
        ? $t('Pinned: {0}. Their pinned output goes to the next steps; nothing else is reused.', [steps.join(', ')])
        : $t('Every step runs, including the pinned ones: {0}.', [steps.join(', ')])}
    />
  </div>
{/if}

<style>
  .option {
    display: flex;
    align-items: flex-start;
    gap: var(--piui-space-2);
    padding: var(--piui-space-3);
    border: 1px solid color-mix(in srgb, var(--piui-accent) 35%, var(--piui-border-subtle));
    border-radius: var(--piui-radius-md);
    background: color-mix(in srgb, var(--piui-accent) 6%, var(--piui-surface-1));
  }
  .mark {
    display: inline-flex;
    margin-top: 1px;
    color: var(--piui-accent);
  }
</style>
