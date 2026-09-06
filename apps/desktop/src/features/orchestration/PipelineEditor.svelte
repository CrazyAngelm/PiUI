<script lang="ts">
  import type { PipelineDefinition, PipelineStep, TeamDefinition, AgentProfile } from '../../../../../contracts/orchestration-v2';
  import { createPipeline, createPipelineStep, removePipelineStep, validatePipeline } from './pipelineForm';

  export let pipeline: PipelineDefinition | undefined;
  export let teams: readonly TeamDefinition[] = [];
  export let profiles: readonly AgentProfile[] = [];
  export let busy = false;
  export let error: string | undefined = undefined;
  export let readOnly = false;
  export let onSave: (pipeline: PipelineDefinition) => void;
  export let onCancel: () => void;
  export let onDirtyChange: (dirty: boolean) => void = () => {};

  let draft: PipelineDefinition = pipeline ? structuredClone(pipeline) : createPipeline(crypto.randomUUID());
  let baseline = JSON.stringify(draft);
  let discardPrompt = false;
  let showValidation = false;
  $: dirty = JSON.stringify(draft) !== baseline;
  $: onDirtyChange(dirty);
  $: validation = validatePipeline(draft);
  $: slots = [...new Map(teams.flatMap((team) => team.members.map((member) => [member.id, {
    id: member.id, label: `${member.id} · ${profiles.find((profile) => profile.id === member.profileId)?.name ?? 'Missing profile'} · ${team.name}`,
  }] as const))).values()];

  function updateStep(id: string, patch: Partial<PipelineStep>): void {
    draft = { ...draft, steps: draft.steps.map((step) => step.id === id ? { ...step, ...patch } : step) };
  }
  function toggleDependency(id: string, dependency: string, checked: boolean): void {
    const step = draft.steps.find((item) => item.id === id);
    if (!step) return;
    updateStep(id, { dependencyStepIds: checked
      ? [...new Set([...step.dependencyStepIds, dependency])]
      : step.dependencyStepIds.filter((value) => value !== dependency) });
  }
  function save(event: SubmitEvent): void {
    event.preventDefault();
    showValidation = true;
    if (busy || readOnly || validation.errors.length > 0) return;
    onSave({ ...draft, name: draft.name.trim() });
  }
  function cancel(): void {
    if (dirty && !readOnly) discardPrompt = true;
    else onCancel();
  }
</script>

<form class="editor" onsubmit={save} aria-labelledby="pipeline-editor-title">
  <header><div><p class="context">Pipeline definition</p><h2 id="pipeline-editor-title">{pipeline ? pipeline.name : 'Create pipeline'}</h2></div><span class="draft-state">{readOnly ? 'Read-only' : dirty ? 'Unsaved changes' : 'No unsaved changes'}</span></header>
  <p class="description">Define task dependencies. Native harnesses execute the tasks; saving does not start a run.</p>
  <fieldset disabled={busy || readOnly}>
    <label for="pipeline-name">Name</label>
    <input id="pipeline-name" value={draft.name} oninput={(event) => draft = { ...draft, name: event.currentTarget.value }} autocomplete="off" />
    <section class="tasks" aria-labelledby="pipeline-tasks-title">
      <div class="section-heading"><h3 id="pipeline-tasks-title">Tasks</h3><button type="button" class="secondary" onclick={() => draft = { ...draft, steps: [...draft.steps, createPipelineStep(crypto.randomUUID())] }}>Add task</button></div>
      <p class="hint">Member slots must match the team selected at launch. Dependency arrows mean “runs after”, not message or spawn permission.</p>
      <datalist id="pipeline-member-slots">{#each slots as slot (slot.id)}<option value={slot.id}>{slot.label}</option>{/each}</datalist>
      {#if draft.steps.length === 0}<p class="empty">No tasks yet. Add a task to describe the work.</p>{/if}
      {#each draft.steps as step, index (step.id)}
        <section class="task" aria-label={`Task ${index + 1}: ${step.name || 'Unnamed task'}`}>
          <div class="section-heading"><h4>Task {index + 1}</h4><button type="button" class="remove" aria-label={`Remove task ${step.name || index + 1}`} onclick={() => draft = removePipelineStep(draft, step.id)}>Remove task</button></div>
          <div class="task-fields">
            <div><label for={`step-name-${step.id}`}>Task name</label><input id={`step-name-${step.id}`} value={step.name} oninput={(event) => updateStep(step.id, { name: event.currentTarget.value })} /></div>
            <div><label for={`step-member-${step.id}`}>Member slot</label><input id={`step-member-${step.id}`} list="pipeline-member-slots" value={step.assignedMemberId} oninput={(event) => updateStep(step.id, { assignedMemberId: event.currentTarget.value })} autocomplete="off" /></div>
          </div>
          <label for={`step-instructions-${step.id}`}>Task instructions</label><textarea id={`step-instructions-${step.id}`} rows="4" value={step.instructions} oninput={(event) => updateStep(step.id, { instructions: event.currentTarget.value })}></textarea>
          <fieldset class="dependencies"><legend>Run after</legend>
            {#each draft.steps.filter((candidate) => candidate.id !== step.id) as dependency (dependency.id)}
              <label class="checkbox"><input type="checkbox" checked={step.dependencyStepIds.includes(dependency.id)} onchange={(event) => toggleDependency(step.id, dependency.id, event.currentTarget.checked)} /><span>{dependency.name || 'Unnamed task'}</span></label>
            {/each}
            {#if draft.steps.length === 1}<p class="hint">This task has no other task to depend on.</p>{/if}
            {#each step.dependencyStepIds.filter((id) => !draft.steps.some((candidate) => candidate.id === id) || id === step.id) as missing (missing)}
              <div class="invalid-dependency"><span>Invalid dependency: {missing === step.id ? 'This task depends on itself' : missing}</span><button type="button" onclick={() => toggleDependency(step.id, missing, false)}>Remove dependency</button></div>
            {/each}
          </fieldset>
        </section>
      {/each}
    </section>
  </fieldset>
  {#if draft.steps.length > 0}
    <section class="dependency-preview" aria-labelledby="dependency-preview-title"><h3 id="dependency-preview-title">Dependency order</h3>
      {#if validation.orderedStepIds.length > 0}<ol>{#each validation.orderedStepIds as id (id)}{@const step = draft.steps.find((item) => item.id === id)}<li><strong>{step?.name}</strong><span>{step?.dependencyStepIds.length ? `After ${step.dependencyStepIds.map((dependency) => draft.steps.find((item) => item.id === dependency)?.name ?? dependency).join(', ')}` : 'Ready when the run starts'}</span></li>{/each}</ol>
      {:else}<p class="hint">Complete task names and member slots, then resolve any missing or cyclic dependencies to preview execution order.</p>{/if}
      <p class="hint">Independent tasks may run in parallel when the host supports it. This list is a dependency preview, not an execution journal.</p>
    </section>
  {/if}
  {#if showValidation && validation.errors.length > 0}<div class="error" role="alert"><strong>Check this pipeline</strong><ul>{#each validation.errors as issue}<li>{issue}</li>{/each}</ul></div>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if discardPrompt}<div class="discard" role="group" aria-label="Unsaved pipeline changes"><p>Discard unsaved pipeline changes?</p><button type="button" class="secondary" onclick={() => discardPrompt = false}>Keep editing</button><button type="button" class="remove" onclick={onCancel}>Discard changes</button></div>{/if}
  <footer><button type="button" class="secondary" onclick={cancel} disabled={busy}>{readOnly ? 'Back' : 'Cancel'}</button>{#if !readOnly}<button type="submit" class="primary" disabled={busy}>{busy ? 'Saving…' : 'Save pipeline'}</button>{/if}</footer>
</form>

<style>
  .editor { display: grid; gap: var(--piui-space-4); min-width: 0; color: var(--piui-text); }
  header, .section-heading, footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--piui-space-3); }
  h2, h3, h4, p { margin: 0; } h2 { font-size: 22px; letter-spacing: -.02em; } h3 { font-size: 15px; } h4 { font-size: 13px; }
  .context, .description, .hint, .draft-state { color: var(--piui-text-muted); font-size: 12px; line-height: 1.5; }.context { margin-bottom: var(--piui-space-1); }
  fieldset { display: grid; min-width: 0; margin: 0; padding: 0; border: 0; gap: var(--piui-space-2); }
  label, legend { color: var(--piui-text); font-size: 13px; font-weight: 600; }
  input:not([type="checkbox"]), textarea { width: 100%; min-width: 0; padding: var(--piui-space-3); border: 1px solid var(--piui-border-strong); border-radius: var(--piui-radius-sm); background: var(--piui-surface-1); color: var(--piui-text); font: inherit; font-size: 13px; }textarea { resize: vertical; line-height: 1.5; }
  input[type="checkbox"] { accent-color: var(--piui-accent); }
  .tasks { display: grid; gap: var(--piui-space-3); margin-top: var(--piui-space-4); }.task { display: grid; gap: var(--piui-space-2); padding: var(--piui-space-4) 0; border-top: 1px solid var(--piui-border); }.task-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--piui-space-3); }.task-fields > div { display: grid; gap: var(--piui-space-2); }
  .dependencies { margin-top: var(--piui-space-2); }.dependencies legend { margin-bottom: var(--piui-space-2); }.checkbox { display: flex; align-items: center; gap: var(--piui-space-2); font-weight: 400; min-height: 32px; }
  button { min-height: 36px; padding: var(--piui-space-2) var(--piui-space-3); border-radius: var(--piui-radius-sm); font-size: 13px; }.secondary { border: 1px solid var(--piui-border); background: var(--piui-surface-1); color: var(--piui-text); }.primary { background: var(--piui-accent); color: var(--piui-accent-ink); font-weight: 600; }.remove { background: transparent; color: var(--piui-danger-text); }button:hover:not(:disabled) { filter: brightness(1.08); }button:disabled { opacity: .6; }
  .empty, .dependency-preview { padding: var(--piui-space-4); background: var(--piui-surface-1); border-radius: var(--piui-radius-md); }.empty { color: var(--piui-text-muted); font-size: 13px; }.dependency-preview ol { display: grid; gap: var(--piui-space-3); padding-left: var(--piui-space-5); }.dependency-preview li { padding-left: var(--piui-space-1); }.dependency-preview li span { display: block; color: var(--piui-text-muted); font-size: 12px; margin-top: var(--piui-space-1); }
  .error { padding: var(--piui-space-3); border: 1px solid var(--piui-danger-border); background: var(--piui-danger-surface); color: var(--piui-danger-text); border-radius: var(--piui-radius-sm); font-size: 13px; }.error ul { margin-bottom: 0; padding-left: var(--piui-space-5); }.invalid-dependency { color: var(--piui-danger-text); font-size: 12px; }.invalid-dependency button { background: transparent; color: inherit; }
  .discard { display: flex; flex-wrap: wrap; gap: var(--piui-space-2); align-items: center; padding: var(--piui-space-3); background: var(--piui-warning-surface); color: var(--piui-warning-text); font-size: 13px; }footer { justify-content: flex-end; padding-top: var(--piui-space-4); border-top: 1px solid var(--piui-border); }
  @media (max-width: 700px) { .task-fields { grid-template-columns: 1fr; } }
</style>
