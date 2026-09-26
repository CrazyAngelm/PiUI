<script lang="ts">
  import { t } from '../../features/locale/language';
  import MarkdownContent from '../../components/MarkdownContent.svelte';
  import type { OrchestrationRunV6 } from '../../host-api/orchestrationClient';
  import { formatValue } from './runPresentation';

  interface Props {
    run: OrchestrationRunV6;
  }
  let { run }: Props = $props();

  // Declaration order first, then any recorded value without a declaration.
  const entries = $derived.by(() => {
    const values = run.inputs ?? {};
    const declared = run.definition.pipeline.inputs ?? [];
    const rows = declared.filter((input) => Object.hasOwn(values, input.name)).map((input) => ({ name: input.name, label: input.label, value: values[input.name] }));
    for (const [name, value] of Object.entries(values)) {
      if (!declared.some((input) => input.name === name)) rows.push({ name, label: name, value });
    }
    return rows;
  });
</script>

{#if entries.length === 0}
  <p class="muted">{$t('This run started without inputs.')}</p>
{:else}
  <dl class="inputs">
    {#each entries as entry (entry.name)}
      <div>
        <dt>{entry.label}</dt>
        <dd>
          {#if typeof entry.value === 'string' && entry.value.length > 80}
            <MarkdownContent source={entry.value} compact={true} />
          {:else if typeof entry.value === 'boolean'}
            {entry.value ? $t('Yes') : $t('No')}
          {:else}
            {formatValue(entry.value)}
          {/if}
        </dd>
      </div>
    {/each}
  </dl>
{/if}

<style>
  .inputs {
    display: grid;
    gap: var(--piui-space-3);
    margin: 0;
  }
  .inputs div {
    display: grid;
    gap: 2px;
  }
  dt {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .muted {
    margin: 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
</style>
