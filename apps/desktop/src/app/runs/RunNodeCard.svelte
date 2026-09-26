<script lang="ts" module>
  import type { Node } from '@xyflow/svelte';
  import type { AgentProfile } from '../../host-api/orchestrationClient';
  import type { StepView } from './runPresentation';

  export interface RunNodeData extends Record<string, unknown> {
    view: StepView;
    profile: AgentProfile | undefined;
    router: boolean;
    /** Current native activity (tool name) while the step works. */
    activity: string;
  }
  export type RunFlowNode = Node<RunNodeData, 'step'>;
</script>

<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Check from '@lucide/svelte/icons/check';
  import X from '@lucide/svelte/icons/x';
  import Clock from '@lucide/svelte/icons/clock';
  import ShieldQuestion from '@lucide/svelte/icons/shield-question';
  import CircleHelp from '@lucide/svelte/icons/circle-help';
  import Ban from '@lucide/svelte/icons/ban';
  import SkipForward from '@lucide/svelte/icons/skip-forward';
  import PhoneIncoming from '@lucide/svelte/icons/phone-incoming';
  import Repeat from '@lucide/svelte/icons/repeat';
  import Split from '@lucide/svelte/icons/split';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Code from '@lucide/svelte/icons/code';
  import { RUNTIME_LABEL } from '../pipelines/executors';
  import { t } from '../../features/locale/language';
  import { Spinner } from '../../lib/ui';
  import HarnessMark from '../shell/HarnessMark.svelte';
  import { harnessMeta } from '../harnessMeta';
  import { STEP_LABEL, STEP_TONE } from './runPresentation';

  let { data, selected }: NodeProps<RunFlowNode> = $props();
  const view = $derived(data.view);
  const tone = $derived(STEP_TONE[view.state]);
  const rounds = $derived(view.attempts.length);
  const script = $derived(view.step.executor?.type === 'script' ? view.step.executor : undefined);
  const llm = $derived(view.step.executor?.type === 'llm');
</script>

<div
  class="card card--{tone}"
  class:card--selected={selected}
  class:card--live={view.state === 'running'}
  class:card--quiet={view.state === 'onCall' || view.state === 'skipped'}
  data-state={view.state}
>
  <Handle type="target" position={Position.Left} id="in" class="run-port" isConnectable={false} />
  <header>
    {#if data.router}
      <span class="router-mark" aria-hidden="true"><Split size={14} /></span>
    {:else if script}
      <span class="router-mark" aria-hidden="true"><Code size={14} /></span>
    {:else if data.profile}
      <HarnessMark kind={data.profile.harness} size={20} />
    {/if}
    <div class="title">
      <strong title={view.name}>{view.name}</strong>
      {#if data.router}
        <span class="sub">{$t('Router')}</span>
      {:else if script}
        <span class="sub">{$t('Script')} · {RUNTIME_LABEL[script.runtime]}</span>
      {:else if data.profile}
        <span class="sub" title={data.profile.model}>{[llm ? $t('Model call') : data.profile.name, harnessMeta(data.profile.harness).short, data.profile.model].filter(Boolean).join(' · ')}</span>
      {/if}
    </div>
  </header>
  <div class="status">
    <span class="status__icon">
      {#if view.state === 'running'}<Spinner size={12} />
      {:else if view.state === 'succeeded'}<Check size={13} />
      {:else if view.state === 'failed'}<X size={13} />
      {:else if view.state === 'awaitingApproval'}<ShieldQuestion size={13} />
      {:else if view.state === 'uncertain' || view.state === 'missing'}<CircleHelp size={13} />
      {:else if view.state === 'cancelled'}<Ban size={13} />
      {:else if view.state === 'skipped'}<SkipForward size={13} />
      {:else if view.state === 'onCall'}<PhoneIncoming size={13} />
      {:else}<Clock size={13} />{/if}
    </span>
    <span class="status__label">{$t(STEP_LABEL[view.state])}</span>
    {#if view.step.review?.maxIterations}
      <span class="chip" title={$t('Review rounds')}><Repeat size={10} /> {Math.min(rounds + 1, view.step.review.maxIterations)}/{view.step.review.maxIterations}</span>
    {:else if rounds > 0}
      <span class="chip" title={$t('Earlier attempts: {0}', [rounds])}><Repeat size={10} /> {rounds + 1}</span>
    {/if}
    {#if view.spawned}
      <span class="chip chip--spawned" title={$t('Started by another agent during this run')}><Sparkles size={10} /> {$t('Spawned')}</span>
    {/if}
  </div>
  {#if view.state === 'running' && data.activity}
    <p class="activity" title={data.activity}>{data.activity}</p>
  {/if}
  <Handle type="source" position={Position.Right} id="out" class="run-port" isConnectable={false} />
</div>

<style>
  .card {
    --tone: var(--piui-border);
    width: 232px;
    padding: 10px 12px;
    border: 1px solid var(--piui-border);
    border-left: 3px solid var(--tone);
    border-radius: 12px;
    background: var(--piui-surface-1);
    box-shadow: var(--piui-shadow-1);
    color: var(--piui-text);
    cursor: pointer;
    transition:
      border-color var(--piui-duration-fast) var(--piui-ease-out),
      box-shadow var(--piui-duration-fast) var(--piui-ease-out),
      opacity var(--piui-duration-fast) var(--piui-ease-out);
  }
  .card--accent {
    --tone: var(--piui-accent);
  }
  .card--success {
    --tone: var(--piui-success);
  }
  .card--warning {
    --tone: var(--piui-warning);
  }
  .card--danger {
    --tone: var(--piui-danger);
  }
  .card--quiet {
    opacity: 0.62;
    border-style: dashed;
    border-left-style: solid;
  }
  .card:hover {
    border-color: var(--piui-border-strong);
    border-left-color: var(--tone);
  }
  .card--selected {
    border-color: var(--piui-accent);
    border-left-color: var(--tone);
    box-shadow:
      0 0 0 3px color-mix(in srgb, var(--piui-accent) 22%, transparent),
      var(--piui-shadow-2);
    opacity: 1;
  }
  .card--live {
    animation: live-glow 1.8s var(--piui-ease-out) infinite;
  }
  @keyframes live-glow {
    50% {
      box-shadow:
        0 0 0 4px color-mix(in srgb, var(--piui-accent) 16%, transparent),
        var(--piui-shadow-1);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .card--live {
      animation: none;
    }
  }
  header {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .router-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    flex: none;
    border-radius: 6px;
    background: color-mix(in srgb, var(--piui-accent) 16%, transparent);
    color: var(--piui-accent);
  }
  .title {
    display: grid;
    min-width: 0;
  }
  strong {
    overflow: hidden;
    font-size: var(--piui-text-md);
    font-weight: var(--piui-weight-semibold);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    overflow: hidden;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
    font-size: var(--piui-text-sm);
  }
  .status__icon {
    display: inline-flex;
    color: var(--tone);
  }
  .card--neutral .status__icon {
    color: var(--piui-text-muted);
  }
  .status__label {
    flex: 1;
    min-width: 0;
    color: var(--piui-text-muted);
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
  .chip--spawned {
    background: var(--piui-warning-surface);
    color: var(--piui-warning);
  }
  .activity {
    margin: 6px 0 0;
    overflow: hidden;
    color: var(--piui-accent);
    font-size: var(--piui-text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
