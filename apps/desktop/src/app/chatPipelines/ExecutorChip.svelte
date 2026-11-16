<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import type { HarnessKind } from '../../../../../contracts/workspace-v15';
  import { t } from '../../features/locale/language';
  import { harnessMeta } from '../harnessMeta';
  import HarnessMark from '../shell/HarnessMark.svelte';

  /** Stands where the executor picker's trigger will be while the picker loads. Keep `.chip` in step with ExecutorPicker. */
  interface Props {
    harness: HarnessKind | '';
    /** Present once loading failed: the chip then asks for the picker again. */
    onRetry?: () => void;
  }
  let { harness, onRetry = undefined }: Props = $props();
</script>

<button type="button" class="chip" disabled={!onRetry} title={onRetry ? $t('Pipelines could not be loaded. Try again.') : $t('Who answers')} onclick={() => onRetry?.()}>
  {#if harness}<HarnessMark kind={harness} size={16} />{/if}
  <span>{harness ? harnessMeta(harness).label : $t('No harness available')}</span>
  <ChevronDown size={12} />
</button>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 260px;
    height: 28px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    white-space: nowrap;
  }
  .chip span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip:hover:not(:disabled) {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .chip:disabled { cursor: default; }
</style>
