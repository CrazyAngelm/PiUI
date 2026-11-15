<script lang="ts">
  import { useTranslation } from '../../../features/locale/context';
  const t = useTranslation();

  interface Props {
    totals: { added: number; removed: number };
  }
  let { totals }: Props = $props();
</script>

<span class="diff-stats" aria-label={$t('{0} lines added, {1} removed', [totals.added, totals.removed])}>
  <span class="diff-stats__added">+{totals.added}</span>
  <span class="diff-stats__removed">−{totals.removed}</span>
</span>

<style>
  .diff-stats {
    display: inline-flex;
    flex: none;
    gap: 5px;
    padding: 1px 5px;
    border-radius: var(--piui-radius-xs);
    background: color-mix(in srgb, var(--piui-surface-1) 70%, transparent);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
  }
  .diff-stats__added { color: var(--piui-success); }
  .diff-stats__removed { color: var(--piui-danger); }
</style>
