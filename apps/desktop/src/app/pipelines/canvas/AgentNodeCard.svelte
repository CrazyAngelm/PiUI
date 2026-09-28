<script lang="ts" module>
  import type { Node } from '@xyflow/svelte';
  import type { GraphNode } from '../../../features/orchestration/agentGraph';
  import type { SubpipelineInfo } from '../../../host-api/subpipelines';

  export interface AgentNodeData extends Record<string, unknown> {
    node: GraphNode;
    problems: number;
    readOnly: boolean;
    /** A sub-pipeline step's child as last read (v6.7); absent while unknown. */
    child?: SubpipelineInfo;
    /** Opens the child pipeline in the editor. */
    onOpenPipeline?: (commandId: string) => void;
  }
  export type AgentFlowNode = Node<AgentNodeData, 'agent'>;
</script>

<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import PhoneIncoming from '@lucide/svelte/icons/phone-incoming';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Zap from '@lucide/svelte/icons/zap';
  import Code from '@lucide/svelte/icons/code';
  import MessageSquareText from '@lucide/svelte/icons/message-square-text';
  import Pin from '@lucide/svelte/icons/pin';
  import Workflow from '@lucide/svelte/icons/workflow';
  import SquareArrowOutUpRight from '@lucide/svelte/icons/square-arrow-out-up-right';
  import { firstCodeLine, RUNTIME_LABEL } from '../executors';
  import { t } from '../../../features/locale/language';
  import HarnessMark from '../../shell/HarnessMark.svelte';
  import { harnessMeta } from '../../harnessMeta';

  let { data, selected }: NodeProps<AgentFlowNode> = $props();
  const node = $derived(data.node);
  const profile = $derived(node.profile);
  const callable = $derived(node.executionMode === 'callable');
  const script = $derived(node.executor?.type === 'script' ? node.executor : undefined);
  const llm = $derived(node.executor?.type === 'llm');
  const codeLine = $derived(script ? firstCodeLine(script.source) : '');
  // v6.7: a sub-pipeline step runs a saved pipeline of this project as a child run.
  const subpipeline = $derived(node.executor?.type === 'pipeline' ? node.executor : undefined);
  const childName = $derived(data.child?.name ?? '');
  const inputsLine = $derived((data.child?.inputs ?? []).map((input) => `${input.name}${input.required ? '*' : ''}`).join(', '));
  const outputsLine = $derived((data.child?.outputs ?? []).map((output) => output.name).join(', '));

  function openChild(event: Event): void {
    event.stopPropagation();
    if (subpipeline?.launchCommandId) data.onOpenPipeline?.(subpipeline.launchCommandId);
  }
</script>

<div class="card" class:card--selected={selected} class:card--callable={callable} class:card--problem={data.problems > 0}>
  <Handle type="target" position={Position.Left} id="in" class="port port--in" isConnectable={!data.readOnly} />
  <header>
    {#if script}
      <span class="mark" aria-hidden="true"><Code size={14} /></span>
    {:else if subpipeline}
      <span class="mark mark--pipeline" aria-hidden="true"><Workflow size={14} /></span>
    {:else}
      <HarnessMark kind={profile.harness} size={20} />
    {/if}
    <div class="title">
      <strong title={profile.name}>{profile.name || (script ? $t('Untitled script') : subpipeline ? $t('Untitled sub-pipeline') : $t('Untitled agent'))}</strong>
      {#if script}
        <span class="sub">{RUNTIME_LABEL[script.runtime]} · {$t('{0} s limit', [script.timeoutSeconds])}</span>
      {:else if subpipeline}
        <span class="sub" title={childName || node.pipelineName}>{$t('Sub-pipeline')} · {childName || (subpipeline.launchCommandId ? $t('Unknown pipeline') : node.pipelineName ? $t('“{0}” not found', [node.pipelineName]) : $t('No pipeline chosen'))}</span>
      {:else}
        <span class="sub" title={profile.model}>
          {[harnessMeta(profile.harness).short, profile.model, profile.reasoning].filter(Boolean).join(' · ')}
          {#if profile.serviceTier === 'fast'}<Zap size={11} />{/if}
        </span>
      {/if}
    </div>
  </header>
  {#if script}
    {#if codeLine}
      <p class="task task--code">{codeLine}</p>
    {:else}
      <p class="task task--empty">{$t('No code yet')}</p>
    {/if}
  {:else if subpipeline}
    {#if data.child}
      <dl class="io">
        <dt>{$t('In')}</dt>
        <dd title={inputsLine}>{inputsLine || $t('none')}</dd>
        <dt>{$t('Out')}</dt>
        <dd title={outputsLine}>{outputsLine || $t('last step text')}</dd>
      </dl>
    {:else}
      <p class="task task--empty">{subpipeline.launchCommandId ? $t('Reading the pipeline…') : node.pipelineName ? $t('Pick a saved pipeline for this step') : $t('Choose a saved pipeline to run')}</p>
    {/if}
  {:else if node.task}
    <p class="task">{node.task}</p>
  {:else}
    <p class="task task--empty">{llm ? $t('No prompt yet') : $t('No task yet')}</p>
  {/if}
  {#if callable || node.requireApproval || data.problems > 0 || llm || script || subpipeline || node.pinnedOutput}
    <footer>
      {#if node.pinnedOutput}<span class="chip chip--pinned" title={$t('Pinned data: a run with pinned data skips this step')}><Pin size={11} /> {$t('Pinned')}</span>{/if}
      {#if llm}<span class="chip" title={$t('One model answer, read-only and without tools')}><MessageSquareText size={11} /> {$t('Model call')}</span>{/if}
      {#if script}<span class="chip" title={$t('Runs on this computer in the project folder')}><Code size={11} /> {$t('Script')}</span>{/if}
      {#if subpipeline}<span class="chip chip--pipeline" title={$t('Runs a saved pipeline as one step')}><Workflow size={11} /> {$t('Pipeline')}</span>{/if}
      {#if callable}<span class="chip" title={$t('Started only when another agent calls it')}><PhoneIncoming size={11} /> {$t('On call')}</span>{/if}
      {#if node.requireApproval}<span class="chip" title={$t('A person approves the result')}><ShieldCheck size={11} /> {$t('Approval')}</span>{/if}
      {#if data.problems > 0}<span class="chip chip--problem"><CircleAlert size={11} /> {data.problems}</span>{/if}
      {#if subpipeline?.launchCommandId && data.onOpenPipeline}
        <button
          type="button"
          class="open nodrag"
          aria-label={$t('Open pipeline {0}', [childName || profile.name])}
          title={$t('Open pipeline {0}', [childName || profile.name])}
          onclick={openChild}
          onkeydown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
          }}
        >
          <SquareArrowOutUpRight size={11} /> {$t('Open')}
        </button>
      {/if}
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
  .mark {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 6px;
    background: var(--piui-surface-3);
    color: var(--piui-text-muted);
  }
  .task.task--code {
    font-family: var(--piui-font-mono);
    font-size: 11px;
    white-space: nowrap;
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
  .chip--pinned {
    background: color-mix(in srgb, var(--piui-accent) 16%, transparent);
    color: var(--piui-accent);
  }
  .mark--pipeline {
    background: color-mix(in srgb, var(--piui-chaos-gold) 18%, var(--piui-surface-3));
    color: var(--piui-chaos-gold);
  }
  .chip--pipeline {
    background: color-mix(in srgb, var(--piui-chaos-gold) 14%, transparent);
    color: var(--piui-text);
  }
  .io {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 2px 8px;
    margin: 8px 0 0;
    font-size: var(--piui-text-xs);
  }
  .io dt {
    color: var(--piui-text-disabled);
  }
  .io dd {
    margin: 0;
    overflow: hidden;
    color: var(--piui-text-muted);
    font-family: var(--piui-font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .open {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-left: auto;
    padding: 0 6px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-full);
    background: transparent;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    line-height: 18px;
    cursor: pointer;
  }
  .open:hover {
    border-color: var(--piui-border-strong);
    color: var(--piui-text);
  }
  .open:focus-visible {
    outline: 2px solid var(--piui-focus);
    outline-offset: 1px;
  }
</style>
