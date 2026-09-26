<script lang="ts" module>
  import type { Node } from '@xyflow/svelte';
  import type { PipelineInput } from '../../../host-api/orchestrationClient';

  export const START_NODE_ID = '__start';

  export interface StartNodeData extends Record<string, unknown> {
    inputs: readonly PipelineInput[];
    problems: number;
  }
  export type StartFlowNode = Node<StartNodeData, 'start'>;
</script>

<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Play from '@lucide/svelte/icons/play';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import { t } from '../../../features/locale/language';

  let { data, selected }: NodeProps<StartFlowNode> = $props();
  const shown = $derived(data.inputs.slice(0, 3));
</script>

<div class="start" class:start--selected={selected} class:start--problem={data.problems > 0}>
  <header>
    <span class="mark" aria-hidden="true"><Play size={12} /></span>
    <strong>{$t('Start')}</strong>
    {#if data.problems > 0}<span class="problem" title={$t('{0} problems', [data.problems])}><CircleAlert size={12} /></span>{/if}
  </header>
  {#if data.inputs.length === 0}
    <p class="muted">{$t('Manual start, no inputs')}</p>
  {:else}
    <ul>
      {#each shown as input (input.name)}
        <li title={input.label}>{input.label}{#if input.required}<span class="req" aria-label={$t('Required')}>*</span>{/if}</li>
      {/each}
      {#if data.inputs.length > shown.length}<li class="muted">{$t('+{0} more', [data.inputs.length - shown.length])}</li>{/if}
    </ul>
  {/if}
  <Handle type="source" position={Position.Right} id="out" class="port port--out" isConnectable={false} />
</div>

<style>
  .start {
    width: 196px;
    padding: 10px 12px;
    border: 1px solid color-mix(in srgb, var(--piui-success) 45%, var(--piui-border));
    border-radius: 14px;
    background: color-mix(in srgb, var(--piui-success) 7%, var(--piui-surface-1));
    box-shadow: var(--piui-shadow-1);
    color: var(--piui-text);
    cursor: pointer;
  }
  .start--selected {
    border-color: var(--piui-accent);
    box-shadow:
      0 0 0 3px color-mix(in srgb, var(--piui-accent) 22%, transparent),
      var(--piui-shadow-2);
  }
  .start--problem:not(.start--selected) {
    border-color: var(--piui-danger-border);
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--piui-success);
    color: var(--piui-bg);
  }
  strong {
    font-size: var(--piui-text-md);
    font-weight: var(--piui-weight-semibold);
  }
  .problem {
    display: inline-flex;
    margin-left: auto;
    color: var(--piui-danger);
  }
  ul {
    display: grid;
    gap: 2px;
    margin: 8px 0 0;
    padding: 0;
    list-style: none;
    font-size: var(--piui-text-sm);
  }
  li {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .req {
    margin-left: 2px;
    color: var(--piui-danger);
  }
  .muted {
    margin: 8px 0 0;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  li.muted {
    margin: 0;
  }
</style>
