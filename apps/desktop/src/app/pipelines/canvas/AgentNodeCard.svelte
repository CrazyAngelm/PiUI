<script lang="ts" module>
  import type { Node } from '@xyflow/svelte';
  import type { GraphNode } from '../../../features/orchestration/agentGraph';

  export interface AgentNodeData extends Record<string, unknown> {
    node: GraphNode;
    problems: number;
    readOnly: boolean;
  }
  export type AgentFlowNode = Node<AgentNodeData, 'agent'>;
</script>

<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import PhoneIncoming from '@lucide/svelte/icons/phone-incoming';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Zap from '@lucide/svelte/icons/zap';
  import { t } from '../../../features/locale/language';
  import HarnessMark from '../../shell/HarnessMark.svelte';
  import { harnessMeta } from '../../harnessMeta';

  let { data, selected }: NodeProps<AgentFlowNode> = $props();
  const node = $derived(data.node);
  const profile = $derived(node.profile);
  const callable = $derived(node.executionMode === 'callable');
</script>

<div class="card" class:card--selected={selected} class:card--callable={callable} class:card--problem={data.problems > 0}>
  <Handle type="target" position={Position.Left} id="in" class="port port--in" isConnectable={!data.readOnly} />
  <header>
    <HarnessMark kind={profile.harness} size={20} />
    <div class="title">
      <strong title={profile.name}>{profile.name || $t('Untitled agent')}</strong>
      <span class="sub" title={profile.model}>
        {[harnessMeta(profile.harness).short, profile.model, profile.reasoning].filter(Boolean).join(' · ')}
        {#if profile.serviceTier === 'fast'}<Zap size={11} />{/if}
      </span>
    </div>
  </header>
  {#if node.task}
    <p class="task">{node.task}</p>
  {:else}
    <p class="task task--empty">{$t('No task yet')}</p>
  {/if}
  {#if callable || node.requireApproval || data.problems > 0}
    <footer>
      {#if callable}<span class="chip" title={$t('Started only when another agent calls it')}><PhoneIncoming size={11} /> {$t('On call')}</span>{/if}
      {#if node.requireApproval}<span class="chip" title={$t('A person approves the result')}><ShieldCheck size={11} /> {$t('Approval')}</span>{/if}
      {#if data.problems > 0}<span class="chip chip--problem"><CircleAlert size={11} /> {data.problems}</span>{/if}
    </footer>
  {/if}
  <Handle type="source" position={Position.Right} id="out" class="port port--out" isConnectable={!data.readOnly} />
</div>

<style>
  .card {
    width: 248px;
    padding: 10px 12px 10px;
    border: 1px solid var(--piui-border);
    border-radius: 12px;
    background: var(--piui-surface-1);
    box-shadow: var(--piui-shadow-1);
    color: var(--piui-text);
    transition:
      border-color var(--piui-duration-fast) var(--piui-ease-out),
      box-shadow var(--piui-duration-fast) var(--piui-ease-out);
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
  .card--callable {
    border-style: dashed;
  }
  .card--problem:not(.card--selected) {
    border-color: var(--piui-danger-border);
  }
  header {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .title {
    display: grid;
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
    display: inline-flex;
    align-items: center;
    gap: 4px;
    overflow: hidden;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .task {
    display: -webkit-box;
    margin: 8px 0 0;
    overflow: hidden;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    line-height: 1.4;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .task--empty {
    color: var(--piui-text-disabled);
    font-style: italic;
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 8px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 0 6px;
    border-radius: var(--piui-radius-full);
    background: var(--piui-surface-2);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    line-height: 18px;
  }
  .chip--problem {
    background: var(--piui-danger-surface);
    color: var(--piui-danger-text);
  }
</style>
