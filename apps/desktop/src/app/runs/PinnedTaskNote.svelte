<script lang="ts">
  import Pin from '@lucide/svelte/icons/pin';
  import { t, language } from '../../features/locale/language';
  import type { OrchestrationRunV6, TaskRecord } from '../../host-api/orchestrationClient';
  import { shortId } from './runPresentation';

  /**
   * Explains a pinned task (orchestration v6.4): the step did not run; its
   * result is the pinned data frozen in this run, with where it came from.
   */
  interface Props {
    run: OrchestrationRunV6;
    record: TaskRecord | undefined;
  }
  let { run, record }: Props = $props();

  const pinned = $derived(
    record?.pinned === true ? run.definition.pipeline.steps.find((step) => step.id === record.stepId)?.pinnedOutput : undefined,
  );
  const source = $derived.by(() => {
    if (pinned === undefined) return '';
    const time = Date.parse(pinned.pinnedAt);
    const when = Number.isFinite(time)
      ? new Date(time).toLocaleString($language === 'ru' ? 'ru-RU' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' })
      : '';
    return pinned.sourceRunId ? $t('Pinned from run #{0}, {1}.', [shortId(pinned.sourceRunId), when]) : when;
  });
</script>

{#if record?.pinned}
  <div class="note" role="note">
    <Pin size={14} />
    <p>
      {record.status === 'failed'
        ? $t('Nothing ran: the pinned data does not match this step’s result fields, so the step failed.')
        : $t('Nothing ran: this step’s result is its pinned data, passed on to the next steps.')}
      {#if source}<span class="source">{source}</span>{/if}
    </p>
  </div>
{/if}

<style>
  .note {
    display: flex;
    gap: var(--piui-space-2);
    margin: 0 var(--piui-space-4) var(--piui-space-2);
    padding: 8px 10px;
    border: 1px solid color-mix(in srgb, var(--piui-accent) 35%, var(--piui-border-subtle));
    border-radius: var(--piui-radius-md);
    background: color-mix(in srgb, var(--piui-accent) 6%, var(--piui-surface-1));
    color: var(--piui-text);
    font-size: var(--piui-text-sm);
  }
  .note :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--piui-accent);
  }
  p {
    margin: 0;
  }
  .source {
    display: block;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
</style>
