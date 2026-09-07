<script lang="ts">
  import { orchestrationHost } from '../../host-api/orchestrationClient';
  import type { UsageReceipt } from '../../../../../contracts/orchestration-host-v6';
  import { usageTotal, runUsageTotal, type UsageMetric } from './runUsage';
  import { onMount } from 'svelte';
  import type { OrchestrationRunV6 } from '../../../../../contracts/orchestration-v6';
  import { workspaceHost, type SessionSnapshot, type WorkspaceClient } from '../../host-api/workspaceClient';
  import { applyWorkspaceEvent } from '../workspace/workspaceState';
  import ConversationViewport from '../workspace/ConversationViewport.svelte';
  import PanelResize from '../../components/PanelResize.svelte';
  import { t } from '../locale/language';
  import { executionLayout } from './executionLayout';
  import { statusPresentation, taskDisplays } from './runView';

  export let run: OrchestrationRunV6;
  export let workspaceId: string;
  export let client: WorkspaceClient = workspaceHost;
  export let onCancelTask: ((stepId: string) => void) | undefined = undefined;
  export let onFlow: ((action: import('../../../../../contracts/orchestration-host-v6').FlowAction) => void) | undefined = undefined;
  export let onOpenSession: ((id: string) => void) | undefined;
  let usage: Record<string, UsageReceipt[]> = {};
  let usageBusy = false;
  let usagePending = false;
  const metrics: [UsageMetric, string][] = [['inputTokens','Input tokens'],['outputTokens','Output tokens'],['cacheReadTokens','Cache read'],['cacheWriteTokens','Cache write'],['totalTokens','Total tokens']];
  let selectedId = '';
  let attemptIndex = -1;
  let activities: Record<string, string> = {};
  let tab: 'overview' | 'conversation' | 'actions' | 'result' = 'overview';
  let snapshots: Record<string, SessionSnapshot> = {};
  let errors: Record<string, string> = {};
  let pending = new Set<string>();
  let mounted = false;
  const reread = new Set<string>();
  let inspectorWidth = 400;
  let lastRunId = '';
  let epoch = 0;
  $: if (run.id !== lastRunId) { lastRunId = run.id; epoch++; usage = {}; snapshots = {}; errors = {}; pending = new Set(); selectedId = ''; attemptIndex = -1; activities = {}; if (mounted) void refreshUsage(); }
  $: displays = taskDisplays(run);
  $: selected = displays.find(display => display.stepId === selectedId);
  $: step = run.definition.pipeline.steps.find(step => step.id === selectedId);
  $: attempt = attemptIndex >= 0 ? run.attempts?.[attemptIndex] : undefined;
  $: viewedSessionId = attempt?.execution?.id ?? selected?.sessionId;
  $: snapshot = viewedSessionId ? snapshots[viewedSessionId] : undefined;
  $: if (mounted) loadMissing([...(viewedSessionId ? [viewedSessionId] : []), ...(tab === 'result' ? (step?.dependencyStepIds ?? []).flatMap(id => { const task = run.tasks.find(task => task.stepId === id); return task?.execution ? [task.execution.id] : []; }) : [])]);
  $: positions = executionLayout(run.definition.pipeline.steps);
  $: allSessionIds = [...run.tasks, ...(run.attempts ?? [])].flatMap(task => task.execution ? [task.execution.id] : []);
  $: viewedTask = attempt ?? selected?.task;
  $: nodePositions = new Map(positions.map(position => [position.id, position]));
  $: actionBlocks = snapshot?.blocks.filter(block => ['tool', 'error', 'custom', 'unknown', 'compaction'].includes(block.kind)) ?? [];
  $: resultReference = (attempt ?? selected?.task)?.resultReference;
  $: resultBlock = resultReference?.blockId ? snapshot?.blocks.find(block => block.id === resultReference.blockId) : snapshot?.blocks.filter(block => block.kind === 'assistant').at(-1);

  async function refreshUsage(): Promise<void> {
    usagePending = true;
    if (usageBusy) return;
    usageBusy = true;
    try {
      while (usagePending && mounted) {
        usagePending = false; const current = epoch;
        try { const next = await orchestrationHost.orchestration_run_usage_v6({ workspaceId, runId: run.id }); if (mounted && current === epoch) { usage = next; errors = {...errors, usage: ''}; } }
        catch { if (mounted && current === epoch) errors = { ...errors, usage: 'Usage is unavailable.' }; }
      }
    } finally { usageBusy = false; }
  }
  function count(value: number | undefined): string { return value === undefined ? '—' : value.toLocaleString(); }
  function loadMissing(ids: string[]): void { for (const id of ids) if (!snapshots[id] && !pending.has(id) && !errors[id]) void read(id); }
  async function read(id: string): Promise<void> {
    if (pending.has(id)) { reread.add(id); return; }
    const current = epoch; pending = new Set(pending).add(id);
    try {
      const next = await client.snapshot(id);
      if (mounted && epoch === current && next.session.workspaceId === workspaceId && (!snapshots[id] || next.revision >= snapshots[id]!.revision)) {
        snapshots = { ...snapshots, [id]: next }; errors = { ...errors, [id]: '' };
      }
    } catch { if (mounted && epoch === current) errors = { ...errors, [id]: 'Could not load native history.' }; }
    finally { if (epoch === current) { const next = new Set(pending); next.delete(id); pending = next; if (reread.delete(id) && mounted) void read(id); } }
  }
  onMount(() => {
    mounted = true; void refreshUsage();
    let stop: (() => void) | undefined;
    void client.listen(event => {
      const current = snapshots[event.sessionId];
      if (event.event.type === 'session' && run.tasks.some(task => task.execution?.id === event.sessionId)) void refreshUsage();
      if (!mounted || !run.tasks.some(task => task.execution?.id === event.sessionId)) return;
      if (event.event.type === 'block' && event.event.block.status === 'streaming') activities = { ...activities, [event.sessionId]: event.event.block.toolName ?? event.event.block.label };
      if (event.event.type === 'session' && event.event.session.status !== 'running') activities = { ...activities, [event.sessionId]: '' };
      if (!current) { if (event.sessionId === viewedSessionId) void read(event.sessionId); return; }
      const result = applyWorkspaceEvent(current, event);
      if (result.type === 'gap') { void read(event.sessionId); return; }
      if (result.type === 'applied') snapshots = { ...snapshots, [event.sessionId]: result.snapshot };
    }).then(unlisten => { if (!mounted) unlisten(); else stop = unlisten; }).catch(() => { errors = { ...errors, stream: 'Live updates are unavailable. Refresh to read native history.' }; });
    return () => { mounted = false; epoch++; stop?.(); };
  });
  function inputPreview(id: string, source: SessionSnapshot | undefined): string {
    const task = run.tasks.find(task => task.stepId === id);
    const fields = step?.inputBindings?.filter(binding => binding.sourceStepId === id) ?? [];
    if (task?.resultData) {
      const value = fields.length ? Object.fromEntries(fields.map(binding => [binding.name, task.resultData?.[binding.field]])) : task.resultData;
      return JSON.stringify(value, null, 2);
    }
    return source?.blocks.find(block => block.id === task?.resultReference?.blockId)?.text ?? $t('Result is not available yet.');
  }
  function activity(id: string): string {
    const item = snapshots[id];
    if (item?.approvals.length) return 'Waiting for approval';
    if (activities[id]) return activities[id]!;
    return item?.blocks.filter(block => block.status === 'streaming').at(-1)?.toolName ?? (item?.session.status === 'running' ? 'Working' : '');
  }
</script>

<section class="execution" aria-label={$t('Execution graph')} style:--inspector-width={`${inspectorWidth}px`}>
  <div class="graph-column">
    <header><strong>{$t(run.paused ? 'Paused' : 'Execution')}</strong>{#if onFlow && run.status === 'running'}<button onclick={() => onFlow?.({ type: run.paused ? 'resume' : 'pause' })}>{$t(run.paused ? 'Resume scheduling' : 'Pause scheduling')}</button>{/if}<span>{$t('Total tokens')}: {count(runUsageTotal(allSessionIds, usage, 'totalTokens'))}</span><button onclick={() => { void refreshUsage(); if (viewedSessionId) void read(viewedSessionId); }} aria-label={$t('Refresh execution')}>{$t('Refresh')}</button></header>
    {#if run.paused}<p>{$t('New tasks are paused. Already running agents continue.')}</p>{/if}
    {#if errors.usage}<p role="status">{$t(errors.usage)}</p>{/if}
    {#if errors.stream}<p role="status">{$t(errors.stream)}</p>{/if}
    <div class="canvas" role="region" aria-label={$t('Execution graph')}>
      <div class="world" style:width={`${Math.max(...positions.map(p => p.x + 280), 320)}px`} style:min-height={`${Math.max(...positions.map(p => p.y + 170), 260)}px`}>
        <svg aria-hidden="true" width="100%" height="100%">
          {#each run.definition.pipeline.steps as destination}
            {#each destination.dependencyStepIds as source}
              {@const from = nodePositions.get(source)}{@const to = nodePositions.get(destination.id)}
              {#if from && to}<path class:complete={run.tasks.find(task => task.stepId === source)?.status === 'succeeded'} d={`M ${from.x + 240} ${from.y + 60} C ${from.x + 270} ${from.y + 60}, ${to.x - 30} ${to.y + 60}, ${to.x} ${to.y + 60}`} />{/if}
            {/each}
          {/each}
        </svg>
        {#each displays as display, index (display.stepId)}
          <button class="agent" class:selected={selectedId === display.stepId} style:left={`${positions[index]?.x ?? 40}px`} style:top={`${positions[index]?.y ?? 64}px`} aria-pressed={selectedId === display.stepId} onclick={() => { selectedId = display.stepId; attemptIndex = -1; }}>
            <small>{display.profile?.harness} · {display.profile?.model}</small><strong>{display.stepName}</strong>
            <span class={`state ${display.status.tone}`}>{$t(display.status.label)}</span>
            <small>{$t('Tokens')}: {count(runUsageTotal([...run.tasks, ...(run.attempts ?? [])].filter(task => task.stepId === display.stepId).flatMap(task => task.execution ? [task.execution.id] : []), usage, 'totalTokens'))}</small>
            {#if display.sessionId}<small>{$t(activity(display.sessionId))}</small>{/if}
          </button>
        {/each}
      </div>
    </div>
    <details class="events"><summary>{$t('Communication history')} · {run.messages.length}</summary>
      {#each run.messages as message (message.id)}<article><strong>{run.definition.team.members.find(member => member.id === message.senderMemberId)?.id} → {message.recipientMemberId}</strong><small>{$t(message.status)}</small><pre>{message.body}</pre></article>{/each}
    </details>
  </div>
  {#if selected}
    <aside class="agent-inspector" aria-label={$t('Agent activity')}>
      <PanelResize label={$t('Resize agent activity')} storageKey="piui.run.inspector.width" initial={400} minimum={260} edge="left" onresize={width => inspectorWidth = width} />
      <header><strong>{selected.stepName}</strong><button aria-label={$t('Close agent activity')} onclick={() => selectedId = ''}>×</button></header>
      <label class="attempt-picker">{$t('Attempt')}<select bind:value={attemptIndex}><option value={-1}>{$t('Current attempt')}</option>{#each run.attempts ?? [] as prior, index}{#if prior.stepId === selectedId}<option value={index}>{$t('Previous attempt')} {index + 1} · {$t(prior.status)}</option>{/if}{/each}</select></label>
      <nav aria-label={$t('Agent details')}>
        {#each [['overview','Overview'],['conversation','Conversation'],['actions','Actions'],['result','Input and result']] as item}<button aria-current={tab === item[0] ? 'page' : undefined} onclick={() => tab = item[0] as typeof tab}>{$t(item[1]!)}</button>{/each}
      </nav>
      {#if viewedSessionId && errors[viewedSessionId]}<p role="alert">{$t(errors[viewedSessionId]!)} <button onclick={() => viewedSessionId && read(viewedSessionId)}>{$t('Refresh')}</button></p>{/if}
      {#if tab === 'conversation' || tab === 'actions'}
        {#if snapshot}<ConversationViewport blocks={tab === 'actions' ? actionBlocks : snapshot.blocks} loading={false} sessionKey={`${snapshot.session.id}:${tab}`} agentLabel={selected.profile?.name ?? ''} />
        {:else}<p>{$t(selected.sessionId ? 'Loading…' : 'This agent has not started.')}</p>{/if}
      {:else}
        <div class="details">
          {#if tab === 'overview'}
            <p>{$t(viewedTask ? statusPresentation(viewedTask.status).label : selected.status.label)}</p>
            {#if onCancelTask && attemptIndex === -1 && ['ready','running','awaitingApproval'].includes(selected.task?.status ?? '')}<button onclick={() => onCancelTask?.(selected!.stepId)}>{$t('Cancel task')}</button>{/if}
            {#if onFlow && attemptIndex === -1 && ['succeeded','failed','cancelled','awaitingApproval'].includes(selected.task?.status ?? '')}<details><summary>{$t('Repeat from this task')}</summary><p>{$t('This starts new attempts for this task and dependent tasks. Check prior effects before repeating.')}</p><button onclick={() => onFlow?.({type:'repeat',stepId:selected!.stepId,taskRevision:selected!.task!.revision})}>{$t('Confirm repeat')}</button></details>{/if}
            {#if onFlow && attemptIndex === -1 && selected.task?.status === 'awaitingApproval'}<button onclick={() => onFlow?.({ type:'decide', stepId:selected!.stepId, taskRevision:selected!.task!.revision, approved:true })}>{$t('Accept result')}</button><button onclick={() => onFlow?.({ type:'decide', stepId:selected!.stepId, taskRevision:selected!.task!.revision, approved:false })}>{$t('Reject result')}</button>{/if}<small>{selected.profile?.harness} · {selected.profile?.model} · {selected.profile?.reasoning ?? $t('Model default')}</small>
            <h3>{$t('Consumption')}</h3><dl>{#each metrics as [metric, label]}<div><dt>{$t(label)}</dt><dd>{count(usageTotal(viewedSessionId ? usage[viewedSessionId] ?? [] : [], metric))}</dd></div>{/each}</dl><small>{$t('Only native counters are shown. A dash means unavailable; cache may be included in input tokens.')}</small>
            <h3>{$t('Task')}</h3><pre>{step?.instructions}</pre>
            <h3>{$t('Waiting for')}</h3>
            {#each step?.dependencyStepIds ?? [] as dependency}<p>{displays.find(display => display.stepId === dependency)?.stepName} · {$t(displays.find(display => display.stepId === dependency)?.status.label ?? '')}</p>{/each}
            {#if viewedTask?.failure}<p role="status">{$t(viewedTask.failure.code)}</p>{/if}
            {#if snapshot?.approvals.length}<p>{$t('Waiting for approval')}</p>{/if}
            {#if viewedSessionId && onOpenSession}<button onclick={() => onOpenSession?.(viewedSessionId!)}>{$t('Open execution session')}</button>{/if}
          {:else}
            <h3>{$t('Input')}</h3><pre>{step?.inputInstructions ?? selected.profile?.inputInstructions ?? ''}</pre>
            {#if attempt}<p>{$t('The original input is preserved in this attempt’s native conversation.')}</p>{:else}
            {#each step?.dependencyStepIds ?? [] as dependency}
              {@const source = displays.find(display => display.stepId === dependency)}
              {@const sourceSnapshot = source?.sessionId ? snapshots[source.sessionId] : undefined}
              <h3>{source?.stepName}</h3><pre>{inputPreview(dependency, sourceSnapshot)}</pre>
            {/each}
            {/if}
            <h3>{$t('Expected result')}</h3><pre>{selected.profile?.expectedResult ?? ''}</pre>
            <h3>{$t('Result')}</h3><pre>{resultBlock?.text ?? $t('Result is not available yet.')}</pre>
          {/if}
        </div>
      {/if}
    </aside>
  {/if}
</section>

<style>
  .attempt-picker { display:flex; justify-content:space-between; padding:var(--piui-space-3); gap:var(--piui-space-2); } select { min-width:0; color:var(--piui-text); background:var(--piui-surface-1); border:1px solid var(--piui-border); }
  dl div { display:flex; justify-content:space-between; gap:var(--piui-space-3); } dd { font-variant-numeric:tabular-nums; }
  .execution { display:flex; min-height:560px; height:65dvh; border:1px solid var(--piui-border); border-radius:var(--piui-radius-md); overflow:hidden; margin-block:var(--piui-space-4); }
  .graph-column { min-width:0; flex:1; display:flex; flex-direction:column; } header { display:flex; align-items:center; justify-content:space-between; gap:var(--piui-space-3); padding:var(--piui-space-3); } header span,small { color:var(--piui-text-muted); font-size:12px; }
  .canvas { overflow:auto; flex:1; background:var(--piui-bg); } .world { position:relative; height:100%; min-height:260px; } svg { position:absolute; pointer-events:none; } path { fill:none; stroke:var(--piui-border); stroke-width:2; } path.complete { stroke:var(--piui-accent); }
  button { font:inherit; cursor:pointer; color:var(--piui-text); background:transparent; border:0; border-radius:var(--piui-radius-sm); padding:var(--piui-space-2); } button:hover { background:var(--piui-surface-2); } button:focus-visible { outline:2px solid var(--piui-focus); }
  .agent { position:absolute; width:240px; min-height:120px; padding:var(--piui-space-4); display:grid; gap:var(--piui-space-2); text-align:left; background:var(--piui-surface-1); border:1px solid var(--piui-border); border-radius:var(--piui-radius-md); } .agent.selected { border-color:var(--piui-accent); } .agent small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .state { font-size:12px; } .danger { color:var(--piui-danger-text); } .active { color:var(--piui-accent); }
  .agent-inspector { position:relative; display:flex; flex-direction:column; width:var(--inspector-width); flex-shrink:0; min-width:0; background:var(--piui-surface-1); border-left:1px solid var(--piui-border); } nav { display:flex; flex-wrap:wrap; padding:var(--piui-space-2); border-block:1px solid var(--piui-border); } nav button[aria-current] { background:var(--piui-surface-2); }
  .details { overflow:auto; padding:var(--piui-space-4); } pre { white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; line-height:1.6; } h3 { font-size:12px; color:var(--piui-text-muted); margin-block:var(--piui-space-4) var(--piui-space-2); } .events { border-top:1px solid var(--piui-border); padding:var(--piui-space-3); max-height:40%; overflow:auto; } article { border-top:1px solid var(--piui-border); padding-block:var(--piui-space-2); } article small { margin-left:var(--piui-space-2); }
  @media(max-width:760px) { .execution { flex-direction:column; height:auto; } .canvas { min-height:240px; } .agent-inspector { width:100%; height:60dvh; border-left:0; border-top:1px solid var(--piui-border); } }
</style>
