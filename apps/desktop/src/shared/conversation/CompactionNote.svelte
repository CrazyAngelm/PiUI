<script lang="ts">
  import { useTranslation } from '../../features/locale/context';
  import type { TimelineBlock } from '../../host-api/types';
  const t = useTranslation();

  let { block }: { block: TimelineBlock } = $props();
  const problem = $derived(block.status === 'failed' || block.status === 'interrupted');
</script>

{#if problem}
  <!-- A compaction that did not finish must not read as one that did. -->
  <div class="divider divider--problem" role="note"><span>{block.status === 'failed' ? $t('Context compaction failed') : $t('Context compaction stopped')}</span></div>
  {#if block.safeSummary}<p class="note">{block.safeSummary}</p>{/if}
{:else}
  <div class="divider"><span>{block.status === 'streaming' ? $t('Compacting context…') : $t('Context compacted')}</span></div>
{/if}

<style>
  .divider {
    display: flex;
    align-items: center;
    gap: var(--piui-space-3);
    margin: var(--piui-space-4) 0 var(--piui-space-6);
    color: var(--piui-text-disabled);
    font-size: var(--piui-text-xs);
  }
  .divider::before,
  .divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--piui-border-subtle);
  }
  .divider--problem {
    margin-bottom: var(--piui-space-2);
    color: var(--piui-danger-text);
  }
  .note {
    margin: 0 0 var(--piui-space-6);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    text-align: center;
  }
</style>
