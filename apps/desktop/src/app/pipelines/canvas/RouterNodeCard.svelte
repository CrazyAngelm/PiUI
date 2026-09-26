<script lang="ts" module>
  import type { Node } from '@xyflow/svelte';
  import type { GraphNode } from '../../../features/orchestration/agentGraph';

  export interface RouterNodeData extends Record<string, unknown> {
    node: GraphNode;
    problems: number;
    readOnly: boolean;
  }
  export type RouterFlowNode = Node<RouterNodeData, 'router'>;
</script>

<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Split from '@lucide/svelte/icons/split';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import { t } from '../../../features/locale/language';

  let { data, selected }: NodeProps<RouterFlowNode> = $props();
  const node = $derived(data.node);
  const branches = $derived(node.router?.branches ?? []);
  const agentMode = $derived(node.router?.mode === 'agent');
</script>

<div class="card" class:card--selected={selected} class:card--problem={data.problems > 0}>
  <Handle type="target" position={Position.Left} id="in" class="port port--in" isConnectable={!data.readOnly} />
  <header>
    <span class="icon"><Split size={14} /></span>
    <div class="title">
      <strong title={node.profile.name}>{node.profile.name || $t('Router')}</strong>
      <span class="sub">{agentMode ? $t('Agent decides') : $t('Rules decide')}</span>
    </div>
    {#if data.problems > 0}<span class="problem"><CircleAlert size={13} /> {data.problems}</span>{/if}
  </header>
  <ul class="branches">
    {#each branches as branch (branch.id)}
      <li>
        <span class="branch__label" title={branch.label}>{branch.label || $t('Route')}</span>
        <Handle type="source" position={Position.Right} id={`branch:${branch.id}`} class="port port--branch" isConnectable={!data.readOnly} />
      </li>
    {/each}
  </ul>
</div>

<style>
  .card {
    width: 248px;
    padding: 10px 0 6px 12px;
    border: 1px solid var(--piui-border);
    border-radius: 12px;
    background: var(--piui-surface-1);
    box-shadow: var(--piui-shadow-1);
    color: var(--piui-text);
  }
  .card:hover {
    border-color: var(--piui-border-strong);
  }
  .card--selected {
    border-color: var(--piui-accent);
    box-shadow:
      0 0 0 3px color-mix(in srgb, var(--piui-accent) 22%, transparent),
      var(--piui-shadow-2);
  }
  .card--problem:not(.card--selected) {
    border-color: var(--piui-danger-border);
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-right: 12px;
  }
  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 5px;
    background: color-mix(in srgb, var(--piui-accent) 16%, transparent);
    color: var(--piui-accent);
    transform: rotate(90deg);
  }
  .title {
    display: grid;
    flex: 1;
    min-width: 0;
  }
  strong {
    overflow: hidden;
    font-size: var(--piui-text-lg);
    font-weight: var(--piui-weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .problem {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    color: var(--piui-danger);
    font-size: var(--piui-text-xs);
  }
  .branches {
    display: grid;
    gap: 2px;
    margin: 8px 0 0;
    padding: 0;
    list-style: none;
  }
  .branches li {
    position: relative;
    display: flex;
    align-items: center;
    height: 26px;
    padding-right: 16px;
    border-top: 1px solid var(--piui-border-subtle);
  }
  .branch__label {
    overflow: hidden;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .branches li :global(.port--branch) {
    top: 50%;
    right: -5px;
  }
</style>
