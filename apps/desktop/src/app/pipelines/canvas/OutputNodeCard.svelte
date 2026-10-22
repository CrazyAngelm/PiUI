<script lang="ts" module>
  import type { Node } from '@xyflow/svelte';
  import type { PipelineOutput } from '../../../host-api/orchestrationClient';

  /** The Output block (v6.7): presentation only, never a step of the saved graph. */
  export const OUTPUT_NODE_ID = '__output';

  export interface OutputNodeData extends Record<string, unknown> {
    outputs: readonly PipelineOutput[];
    problems: number;
  }
  export type OutputFlowNode = Node<OutputNodeData, 'output'>;
</script>

<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import LogOut from '@lucide/svelte/icons/log-out';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import { t } from '../../../features/locale/language';

  let { data, selected }: NodeProps<OutputFlowNode> = $props();
  const shown = $derived(data.outputs.slice(0, 3));
</script>

<div class="output" class:output--selected={selected} class:output--problem={data.problems > 0}>
  <Handle type="target" position={Position.Left} id="in" class="port port--in" isConnectable={false} />
  <header>
    <span class="mark" aria-hidden="true"><LogOut size={12} /></span>
    <strong>{$t('Output')}</strong>
    {#if data.problems > 0}<span class="problem" title={$t('{0} problems', [data.problems])}><CircleAlert size={12} /></span>{/if}
  </header>
  {#if data.outputs.length === 0}
    <p class="muted">{$t('No declared outputs')}</p>
  {:else}
    <ul>
      {#each shown as output (output.name)}
        <li title={output.name}><span class="name">{output.name}</span> <span class="kind">{output.kind}</span></li>
      {/each}
      {#if data.outputs.length > shown.length}<li class="muted">{$t('+{0} more', [data.outputs.length - shown.length])}</li>{/if}
    </ul>
  {/if}
</div>

<style>
  .output {
    width: 196px;
    padding: 10px 12px;
    border: 1px solid color-mix(in srgb, var(--piui-chaos-gold) 45%, var(--piui-border));
    border-radius: 14px;
    background: color-mix(in srgb, var(--piui-chaos-gold) 6%, var(--piui-surface-1));
    box-shadow: var(--piui-shadow-1);
    color: var(--piui-text);
    cursor: pointer;
  }
  .output--selected {
    border-color: var(--piui-accent);
    box-shadow:
      0 0 0 3px color-mix(in srgb, var(--piui-accent) 22%, transparent),
      var(--piui-shadow-2);
  }
  .output--problem:not(.output--selected) {
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
    background: var(--piui-chaos-gold);
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
  .name {
    font-family: var(--piui-font-mono);
    font-size: var(--piui-text-xs);
  }
  .kind {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
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
