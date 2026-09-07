<script lang="ts">
  import RunExecution from './RunExecution.svelte';
  import { t } from '../locale/language';
  import type { OrchestrationRunV6, TaskRecord } from '../../../../../contracts/orchestration-v6';
  import type { ReconcileUncertainTaskRequest } from '../../../../../contracts/orchestration-host-v6';
  import { memberLabel, statusPresentation, taskDisplays } from './runView';

  export let run: OrchestrationRunV6;
  export let workspaceId = "";
  export let onCancelTask: ((stepId: string) => void) | undefined = undefined;
  export let onFlow: ((action: import('../../../../../contracts/orchestration-host-v6').FlowAction) => void) | undefined = undefined;
  export let onClose: () => void;
  export let onOpenSession: ((sessionId: string) => void) | undefined = undefined;
  export let busy = false;
  export let error: string | undefined = undefined;
  export let onCancelRun: (() => void) | undefined = undefined;
  export let onRetryTask: ((task: TaskRecord) => void) | undefined = undefined;
  export let onReconcileTask: ((task: TaskRecord, resolution: ReconcileUncertainTaskRequest['resolution']) => void) | undefined = undefined;

  let cancellingRunKey: string | undefined;
  let retryingTask: { readonly runKey: string; readonly stepId: string; readonly revision: number } | undefined;
  let retryConfirmation: TaskRecord | undefined;
  let retryConfirmationRunKey: string | undefined;
  let reconcileConfirmation: { readonly task: TaskRecord; readonly resolution: ReconcileUncertainTaskRequest['resolution']; readonly runKey: string } | undefined;
  let reconciliationAcknowledged = false;
  let reconcilingTask: { readonly runKey: string; readonly stepId: string; readonly revision: number } | undefined;
  let previousError: string | undefined;
  let taskQuery = '';
  let taskFilter = 'all';

  $: displays = taskDisplays(run);
  $: visibleDisplays = displays.filter(display => `${display.stepName} ${display.profile?.name ?? ''} ${display.profile?.harness ?? ''}`.toLowerCase().includes(taskQuery.toLowerCase())
    && (taskFilter === 'all' || (taskFilter === 'active' ? ['running', 'ready'].includes(display.task?.status ?? '') : taskFilter === 'attention' ? ['failed', 'uncertain'].includes(display.task?.status ?? '') : ['succeeded', 'cancelled'].includes(display.task?.status ?? ''))));
  $: snapshotStepIds = new Set(run.definition.pipeline.steps.map((step) => step.id));
  $: journalOnlyTasks = run.tasks.filter((task) => !snapshotStepIds.has(task.stepId));
  $: runState = statusPresentation(run.status);
  $: runKey = `${run.id}:${run.revision}`;
  $: cancelPending = cancellingRunKey === runKey;
  $: retryPending = retryingTask?.runKey === runKey;
  $: reconcilePending = reconcilingTask?.runKey === runKey;
  $: invalidateStaleRetryConfirmation(runKey, run.tasks);
  $: invalidateStaleReconcileConfirmation(runKey, run.tasks);
  $: clearPendingOnError(error);

  function invalidateStaleRetryConfirmation(runKey: string, tasks: readonly TaskRecord[]): void {
    if (retryConfirmation === undefined) return;
    const stillCurrent = retryConfirmationRunKey === runKey && tasks.some((task) =>
      task.stepId === retryConfirmation?.stepId
      && task.revision === retryConfirmation?.revision
      && task.status === 'uncertain',
    );
    if (!stillCurrent) {
      retryConfirmation = undefined;
      retryConfirmationRunKey = undefined;
    }
  }

  function clearPendingOnError(nextError: string | undefined): void {
    if (nextError === previousError) return;
    previousError = nextError;
    if (nextError !== undefined) {
      cancellingRunKey = undefined;
      retryingTask = undefined;
      reconcilingTask = undefined;
    }
  }

  function invalidateStaleReconcileConfirmation(runKey: string, tasks: readonly TaskRecord[]): void {
    if (reconcileConfirmation === undefined) return;
    const task = reconcileConfirmation.task;
    if (reconcileConfirmation.runKey !== runKey || !tasks.some((candidate) =>
      candidate.stepId === task.stepId && candidate.revision === task.revision && candidate.status === 'uncertain',
    )) {
      reconcileConfirmation = undefined;
      reconciliationAcknowledged = false;
    }
  }

  function requestCancelRun(): void {
    if (busy || cancelPending || onCancelRun === undefined || run.status !== 'running') return;
    cancellingRunKey = runKey;
    onCancelRun();
  }

  function confirmRetry(task: TaskRecord): void {
    if (busy || retryPending || onRetryTask === undefined || task.status !== 'uncertain') return;
    retryConfirmation = undefined;
    retryConfirmationRunKey = undefined;
    retryingTask = { runKey, stepId: task.stepId, revision: task.revision };
    onRetryTask(task);
  }

  function chooseReconciliation(task: TaskRecord, resolution: ReconcileUncertainTaskRequest['resolution']): void {
    if (busy || reconcilePending || onReconcileTask === undefined || task.status !== 'uncertain') return;
    reconciliationAcknowledged = false;
    reconcileConfirmation = { task, resolution, runKey };
  }

  function confirmReconciliation(): void {
    const confirmation = reconcileConfirmation;
    if (busy || reconcilePending || onReconcileTask === undefined || confirmation === undefined) return;
    const currentTask = run.tasks.find((task) => task.stepId === confirmation.task.stepId && task.revision === confirmation.task.revision);
    if (confirmation.runKey !== runKey || currentTask?.status !== 'uncertain') {
      reconcileConfirmation = undefined;
      reconciliationAcknowledged = false;
      return;
    }
    if (!reconciliationAcknowledged) return;
    reconcileConfirmation = undefined;
    reconciliationAcknowledged = false;
    reconcilingTask = { runKey, stepId: currentTask.stepId, revision: currentTask.revision };
    onReconcileTask(currentTask, confirmation.resolution);
  }

  function resultReference(task: TaskRecord): string {
    const reference = task.resultReference;
    if (reference === undefined) return '';
    return reference.blockId === undefined
      ? `Session ${reference.sessionId}`
      : `Session ${reference.sessionId}  /  block ${reference.blockId}`;
  }

  function profileName(profileId: string): string {
    return run.definition.profiles.find((profile) => profile.id === profileId)?.name || `Unknown profile (${profileId})`;
  }
</script>

<aside class="inspector" aria-labelledby="run-inspector-title">
  <header class="inspector__header">
    <div>
      <p class="eyebrow">{$t('Run')}</p>
      <h2 id="run-inspector-title">{run.definition.pipeline.name || run.id}</h2>
      <details class="metadata"><summary>{$t('Run details')}</summary><p>{run.id} · r{run.revision}</p></details>
    </div>
    <button class="quiet-button" type="button" onclick={onClose} aria-label={$t('Close run inspector')}>{$t('Close')}</button>
  </header>

  <p class:status--neutral={runState.tone === 'neutral'} class:status--active={runState.tone === 'active'} class:status--success={runState.tone === 'success'} class:status--danger={runState.tone === 'danger'} class:status--warning={runState.tone === 'warning'} class="status" aria-label={`Run status: ${runState.label}`}><span aria-hidden="true">{runState.icon}</span> {runState.label}</p>
  {#if run.status === 'uncertain'}<p class="reconcile" role="status">{$t('Run state needs reconciliation. No outcome is inferred.')}</p>{/if}
  {#if onCancelRun !== undefined && run.status === 'running'}
    <section class="run-controls" aria-label={$t('Run controls')}>
      <button class="danger-button" type="button" onclick={requestCancelRun} disabled={busy || cancelPending}>{cancelPending ? 'Cancelling run...' : 'Cancel run'}</button>
      <p class="section-note">{$t('Cancel run is distinct from stopping an individual session turn.')}</p>
    </section>
  {/if}
  {#if error !== undefined}<p class="error" role="alert">{error}</p>{/if}

  {#if workspaceId}{#key run.id}<RunExecution {run} {workspaceId} {onOpenSession} {onFlow} {onCancelTask} />{/key}{/if}
  <details open={!workspaceId || run.status === 'uncertain'}><summary>{$t('Task records and recovery')}</summary>
  <section aria-labelledby="tasks-title">
    <h3 id="tasks-title">{$t('Tasks ')}<span class="metadata">{visibleDisplays.length} / {displays.length}</span></h3>
    <div class="task-filters"><label>{$t('Find agent or task')}<input type="search" bind:value={taskQuery} placeholder={$t('Search this run')} /></label><label>{$t('Status')}<select bind:value={taskFilter}><option value="all">{$t('All tasks')}</option><option value="active">{$t('Active')}</option><option value="attention">{$t('Needs attention')}</option><option value="completed">{$t('Completed')}</option></select></label></div>
    {#if displays.length === 0}<p class="empty">{$t('No pipeline tasks are present in this definition snapshot.')}</p>{/if}
    {#if displays.length > 0 && visibleDisplays.length === 0}<p class="empty" role="status">{$t('No tasks match these filters.')}</p>{/if}
    <ol class="task-list">
      {#each visibleDisplays as display (display.stepId)}
        <li class="task">
          <div class="task__title"><strong>{display.stepName}</strong><span class={`status status--${display.status.tone}`} aria-label={`Task status: ${display.status.label}`}><span aria-hidden="true">{display.status.icon}</span> {display.status.label}</span></div>
          <p class="metadata">Member: {display.profile?.name || display.member?.id || `Unknown member (${display.stepId})`}</p>
          {#if display.task === undefined}
            <p class="reconcile">{$t('No task journal record. Needs reconciliation.')}</p>
          {:else}
            {#if display.task.failure !== undefined}<p class="failure"><strong>{$t('Failure code:')}</strong> <code>{display.task.failure.code}</code></p>{/if}
            {#if display.task.resultReference !== undefined}<p class="reference"><strong>{$t('Result reference:')}</strong> {resultReference(display.task)}</p>{/if}
            {#if display.sessionId !== undefined}
              <button class="link-button" type="button" onclick={() => onOpenSession?.(display.sessionId!)} disabled={onOpenSession === undefined} aria-label={`Open execution session for ${display.stepName}`}>{$t('Open execution session')}</button>
              {#if onOpenSession === undefined}<p class="metadata">{$t('Session opening is unavailable in this view.')}</p>{/if}
            {/if}
            {#if onRetryTask !== undefined && display.task.status === 'uncertain' && display.sessionId !== undefined}
              {#if retryConfirmation?.stepId === display.task.stepId && retryConfirmation.revision === display.task.revision}
                <div class="retry-confirmation" role="group" aria-label={`Confirm retry for ${display.stepName}`}>
                  <p>{$t('A retry starts a new attempt; it does not automatically replay the prior attempt. Native side effects may already exist. Check the native session before retrying.')}</p>
                  <button class="link-button" type="button" onclick={() => onOpenSession?.(display.sessionId!)} disabled={onOpenSession === undefined}>{$t('Check native session')}</button>
                  <button class="danger-button" type="button" onclick={() => confirmRetry(display.task!)} disabled={busy || retryPending}>{retryPending ? 'Retrying task...' : 'Confirm retry task'}</button>
                  <button class="quiet-button" type="button" onclick={() => { retryConfirmation = undefined; retryConfirmationRunKey = undefined; }} disabled={busy || retryPending}>{$t('Keep investigating')}</button>
                </div>
              {:else}
                <button class="link-button" type="button" onclick={() => { retryConfirmation = display.task; retryConfirmationRunKey = runKey; }} disabled={busy || retryPending} aria-label={`Retry uncertain task ${display.stepName}`}>{$t('Retry uncertain task')}</button>
              {/if}
            {/if}
            {#if onReconcileTask !== undefined && display.task.status === 'uncertain' && display.sessionId !== undefined}
              {#if reconcileConfirmation?.task.stepId === display.task.stepId && reconcileConfirmation.task.revision === display.task.revision}
                <div class="retry-confirmation" role="group" aria-label={`Confirm operator assertion for ${display.stepName}`}>
                  <p>{$t('Check the native session before recording this operator assertion. It reconciles the journal only.')}</p>
                  {#if reconcileConfirmation.resolution.status === 'succeeded'}<p>{$t('Recording succeeded can unblock dependent tasks. It does not prove native completion.')}</p>{/if}
                  {#if reconcileConfirmation.resolution.status === 'cancelled'}<p>{$t('Recording cancelled does not stop a native process.')}</p>{/if}
                  {#if reconcileConfirmation.resolution.status === 'failed'}<p>{$t('Failure uses the fixed safe marker ')}<code>{$t('OPERATOR_ASSERTED_FAILURE')}</code>.</p>{/if}
                  <button class="link-button" type="button" onclick={() => onOpenSession?.(display.sessionId!)} disabled={onOpenSession === undefined}>{$t('Check native session')}</button>
                  <label class="acknowledgement"><input type="checkbox" checked={reconciliationAcknowledged} onchange={(event) => reconciliationAcknowledged = event.currentTarget.checked} disabled={busy || reconcilePending} /> I checked the linked native session and understand this is an operator assertion.</label>
                  <button class="danger-button" type="button" onclick={confirmReconciliation} disabled={busy || reconcilePending || !reconciliationAcknowledged}>{reconcilePending ? 'Recording assertion...' : 'Confirm operator assertion'}</button>
                  <button class="quiet-button" type="button" onclick={() => { reconcileConfirmation = undefined; reconciliationAcknowledged = false; }} disabled={busy || reconcilePending}>{$t('Keep investigating')}</button>
                </div>
              {:else}
                <div class="reconcile-actions" role="group" aria-label={`Reconcile uncertain task ${display.stepName}`}>
                  <p class="section-note">{$t('After checking the linked native session, record an operator assertion.')}</p>
                  <button class="quiet-button" type="button" onclick={() => chooseReconciliation(display.task!, { status: 'succeeded' })} disabled={busy || reconcilePending || run.definition.pipeline.steps.some(step => step.id === display.stepId && ((step.resultFields?.length ?? 0) > 0 || step.requireApproval || step.review))}>{$t('Record succeeded')}</button>
                  <button class="quiet-button" type="button" onclick={() => chooseReconciliation(display.task!, { status: 'failed', failureCode: 'OPERATOR_ASSERTED_FAILURE' })} disabled={busy || reconcilePending}>{$t('Record failed')}</button>
                  <button class="quiet-button" type="button" onclick={() => chooseReconciliation(display.task!, { status: 'cancelled' })} disabled={busy || reconcilePending}>{$t('Record cancelled')}</button>
                </div>
              {/if}
            {/if}
          {/if}
        </li>
      {/each}
    </ol>
    {#if journalOnlyTasks.length > 0}
      <section class="reconciliation" aria-labelledby="journal-only-title">
        <h4 id="journal-only-title">{$t('Journal records needing reconciliation')}</h4>
        {#each journalOnlyTasks as task (task.stepId)}
          {@const state = statusPresentation(task.status)}
          <p><strong>{task.stepId}</strong>  /  <span class={`status status--${state.tone}`}><span aria-hidden="true">{state.icon}</span> {state.label}</span>  /  This step is absent from the definition snapshot.</p>
        {/each}
      </section>
    {/if}
  </section>

  </details>
  <section aria-labelledby="messages-title">
    <h3 id="messages-title">{$t('Messages')}</h3>
    <p class="section-note">{$t('Delivery is separate from observation. Accepted is not proof that a recipient read or acted on a message.')}</p>
    {#if run.messages.length === 0}<p class="empty">{$t('No message delivery records.')}</p>{/if}
    <ul class="message-list">
      {#each run.messages as message (message.id)}
        {@const delivery = statusPresentation(message.status)}
        <li>
          <p><strong>{memberLabel(run, message.senderMemberId)}</strong> to <strong>{memberLabel(run, message.recipientMemberId)}</strong> <span class={`status status--${delivery.tone}`} aria-label={`Delivery state: ${delivery.label}`}><span aria-hidden="true">{delivery.icon}</span> {delivery.label}</span></p>
          <p class="metadata">Message revision {message.revision}</p>
          <details><summary>{$t('Message content')}</summary><pre>{message.body}</pre></details>
        </li>
      {/each}
    </ul>
  </section>

  <details class="snapshot">
    <summary>{$t('Definition used (read-only snapshot)')}</summary>
    <section aria-labelledby="pipeline-title"><h3 id="pipeline-title">Pipeline  /  {run.definition.pipeline.name}</h3>
      <ul>{#each run.definition.pipeline.steps as step (step.id)}<li><strong>{step.name || step.id}</strong>  /  assigned to {memberLabel(run, step.assignedMemberId)}{#if step.dependencyStepIds.length > 0}<span class="metadata">  /  after {step.dependencyStepIds.join(', ')}</span>{/if}<details><summary>{$t('Task instructions')}</summary><pre>{step.instructions}</pre></details></li>{/each}</ul>
    </section>
    <section aria-labelledby="team-title"><h3 id="team-title">Team  /  {run.definition.team.name}</h3>
      <p class="metadata">Coordinator: {memberLabel(run, run.definition.team.orchestratorMemberId)}</p>
      <h4>{$t('Members')}</h4><ul>{#each run.definition.team.members as member (member.id)}<li>{memberLabel(run, member.id)}  /  {profileName(member.profileId)}</li>{/each}</ul>
      <h4>{$t('Messaging policy')}</h4>{#if run.definition.team.sendEdges.length === 0}<p class="empty">{$t('No messaging permissions declared.')}</p>{:else}<ul>{#each run.definition.team.sendEdges as edge (`${edge.fromMemberId}-${edge.toMemberId}`)}<li>{memberLabel(run, edge.fromMemberId)} may send messages to {memberLabel(run, edge.toMemberId)}</li>{/each}</ul>{/if}
      <h4>{$t('Observation policy')}</h4>{#if run.definition.team.observeEdges.length === 0}<p class="empty">{$t('No observation permissions declared.')}</p>{:else}<ul>{#each run.definition.team.observeEdges as edge (`${edge.fromMemberId}-${edge.toMemberId}`)}<li>{memberLabel(run, edge.fromMemberId)} may observe {memberLabel(run, edge.toMemberId)}</li>{/each}</ul>{/if}
    </section>
    <section aria-labelledby="profiles-title"><h3 id="profiles-title">{$t('Harness profiles')}</h3>
      {#each run.definition.profiles as profile (profile.id)}
        <article class="profile"><h4>{profile.name || profile.id}</h4><p class="metadata">{profile.harness}  /  {profile.model}  /  {profile.permissionMode}</p><details><summary>{$t('Profile instructions')}</summary><pre>{profile.instructions}</pre></details><h5>{$t('Allowed workspace child templates')}</h5><p class="section-note">{$t('This controls coordinator Workspace template launches only. It does not describe native RLM, Python, or process spawning, and makes no OS sandbox promise.')}</p>{#if profile.allowedSpawnProfileIds.length === 0}<p class="empty">{$t('No workspace child templates are allowed by this profile.')}</p>{:else}<ul>{#each profile.allowedSpawnProfileIds as childId}<li>{profileName(childId)}</li>{/each}</ul>{/if}</article>
      {/each}
    </section>
  </details>
</aside>

<style>
  .task-filters { display:flex; flex-wrap:wrap; gap:.75rem; margin:.8rem 0; } .task-filters label { display:grid; gap:.35rem; font-size:.75rem; color:var(--piui-text-muted); } .task-filters input,.task-filters select { background:var(--piui-bg-raised); color:var(--piui-text); border:1px solid var(--piui-border); border-radius:var(--piui-radius-sm); font:inherit; padding:.55rem; } .task-filters input:focus-visible,.task-filters select:focus-visible { outline:2px solid var(--piui-focus); outline-offset:2px; }
  .inspector { display: grid; gap: var(--piui-space-4); min-width: 0; color: var(--piui-text); }
  .inspector__header { display: flex; align-items: start; justify-content: space-between; gap: var(--piui-space-3); padding-bottom: var(--piui-space-3); border-bottom: 1px solid var(--piui-border); }
  h2, h3, h4, h5, p { margin: 0; } h2 { font-size: 20px; letter-spacing: -.02em; } h3 { font-size: 15px; } h4 { font-size: 13px; } h5 { font-size: 12px; }
  .eyebrow, .metadata, .section-note, .empty { color: var(--piui-text-muted); font-size: 12px; line-height: 1.5; }.eyebrow { margin-bottom: var(--piui-space-1); }.metadata { margin-top: var(--piui-space-1); }.section-note { margin: var(--piui-space-2) 0; }.empty { padding: var(--piui-space-2) 0; }
  .quiet-button, .link-button, .danger-button { min-height: 34px; padding: var(--piui-space-2) var(--piui-space-3); border: 1px solid var(--piui-border); border-radius: var(--piui-radius-sm); background: var(--piui-surface-1); color: var(--piui-text); font: inherit; font-size: 13px; }.link-button { margin-top: var(--piui-space-2); color: var(--piui-accent); }.danger-button { margin-top: var(--piui-space-2); border-color: var(--piui-danger); color: var(--piui-danger); }.run-controls { padding: var(--piui-space-3); border: 1px solid var(--piui-border); border-radius: var(--piui-radius-sm); background: var(--piui-surface-1); }.error { padding: var(--piui-space-3); border: 1px solid var(--piui-danger); border-radius: var(--piui-radius-sm); color: var(--piui-danger); font-size: 13px; }.acknowledgement { display: flex; align-items: start; gap: var(--piui-space-2); font-size: 13px; }.acknowledgement input { accent-color: var(--piui-accent); margin-top: 3px; }.reconcile-actions { display: flex; flex-wrap: wrap; gap: var(--piui-space-2); margin-top: var(--piui-space-2); }.reconcile-actions .section-note { flex-basis: 100%; }.retry-confirmation { display: grid; gap: var(--piui-space-2); margin-top: var(--piui-space-2); padding: var(--piui-space-3); border-left: 2px solid var(--piui-warning); background: var(--piui-surface-2); color: var(--piui-text); font-size: 13px; }button:focus-visible, summary:focus-visible { outline: 2px solid var(--piui-focus); outline-offset: 2px; }button:disabled { opacity: .6; }
  .status { display: inline-flex; align-items: center; gap: 4px; width: fit-content; font-size: 12px; font-weight: 600; }.status--neutral { color: var(--piui-text-muted); }.status--active { color: var(--piui-accent); }.status--success { color: var(--piui-success); }.status--danger { color: var(--piui-danger); }.status--warning { color: var(--piui-warning); }
  section { display: grid; gap: var(--piui-space-2); }.task-list, .message-list { display: grid; gap: var(--piui-space-3); padding: 0; margin: 0; list-style: none; }.task, .message-list li, .reconciliation, .profile { padding: var(--piui-space-3); border: 1px solid var(--piui-border); border-radius: var(--piui-radius-sm); background: var(--piui-surface-1); }.task__title { display: flex; align-items: baseline; justify-content: space-between; gap: var(--piui-space-2); }.failure { margin-top: var(--piui-space-2); color: var(--piui-danger); font-size: 13px; }.reference { margin-top: var(--piui-space-2); font-size: 13px; }.reconcile { margin-top: var(--piui-space-2); color: var(--piui-warning); font-size: 13px; }.reconciliation { border-color: var(--piui-warning); }.reconciliation p { font-size: 13px; }
  details { min-width: 0; } summary { cursor: pointer; color: var(--piui-text); font-size: 13px; font-weight: 600; } pre { overflow-wrap: anywhere; white-space: pre-wrap; margin: var(--piui-space-2) 0 0; padding: var(--piui-space-2); border-radius: var(--piui-radius-sm); background: var(--piui-surface-2); color: var(--piui-text); font: 12px/1.5 var(--piui-font-mono); }.snapshot { display: grid; gap: var(--piui-space-3); padding-top: var(--piui-space-3); border-top: 1px solid var(--piui-border); }.snapshot[open] { gap: var(--piui-space-4); }.snapshot section { padding-top: var(--piui-space-2); }.snapshot ul { display: grid; gap: var(--piui-space-2); margin: 0; padding-left: var(--piui-space-5); font-size: 13px; }.snapshot li > details { margin-top: var(--piui-space-2); }.profile { display: grid; gap: var(--piui-space-2); }.profile + .profile { margin-top: var(--piui-space-2); }
</style>
