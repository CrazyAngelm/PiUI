<script lang="ts">
  import { t } from '../../features/locale/language';
  import { Badge } from '../../lib/ui';
  import { roundOutcomeLabel } from './fusionState';
  import { sidekickChip, type SidekickBlockView } from './sidekickBlock';

  /**
   * The compact card of one `sidekick` tool call in a lead chat (ADR-043).
   * Everything comes from `parseSidekickBlock`, which reads only the host's
   * header lines; the result text below them is plain preformatted text.
   */
  interface Props {
    view: SidekickBlockView;
  }
  let { view }: Props = $props();

  const chip = $derived(sidekickChip(view));
</script>

<section class="card" aria-label={$t('Sidekick call')}>
  <header class="card__head">
    <Badge tone={chip.tone}>{$t(chip.label)}</Badge>
    {#if view.op}<span class="card__op">{view.op}</span>{/if}
    {#if view.briefId}<span class="card__id">{$t('Brief {0}', [view.briefId])}</span>{/if}
    {#if view.roundId}<span class="card__id">{$t('Round {0}', [view.roundId])}</span>{/if}
    {#if view.kind === 'report'}
      {#if view.outcome}<span class="card__meta">{$t(roundOutcomeLabel(view.outcome))}</span>{/if}
      {#if view.duration}<span class="card__meta">{view.duration}</span>{/if}
      {#if view.truncated}<span class="card__meta">{$t('shortened')}</span>{/if}
    {:else if view.kind === 'progress'}
      <span class="card__meta">{view.state}</span>
      <span class="card__meta">{view.elapsed}</span>
    {:else if view.kind === 'status'}
      <span class="card__meta">{view.state}</span>
    {:else if view.kind === 'report-page'}
      <span class="card__meta">{$t('Page {0} of {1}', [view.page, view.pages])}</span>
    {:else if view.kind === 'refused'}
      <span class="card__meta">{view.code}</span>
    {/if}
  </header>
  {#if view.rest}<pre class="card__text">{view.rest}</pre>{/if}
</section>

<style>
  .card {
    display: grid;
    gap: 6px;
    padding: 8px 10px;
    border: 1px solid var(--piui-border-subtle);
    border-left: 3px solid var(--piui-chaos-gold);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-surface-1);
  }
  .card__head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: var(--piui-text-xs);
  }
  .card__op,
  .card__id {
    color: var(--piui-text);
    font-family: var(--piui-font-mono);
  }
  .card__meta {
    color: var(--piui-text-muted);
  }
  .card__text {
    max-height: 360px;
    margin: 0;
    padding: 8px 10px;
    overflow: auto;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-sm);
    background: var(--piui-code-surface);
    color: var(--piui-text);
    font-family: var(--piui-font-mono);
    font-size: var(--piui-chat-code-font-size);
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
