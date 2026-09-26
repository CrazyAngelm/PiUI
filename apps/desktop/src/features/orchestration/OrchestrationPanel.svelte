<script module lang="ts">
  export type OrchestrationSection = 'systems' | 'agents' | 'teams' | 'pipelines' | 'schedules' | 'runs';
</script>

<script lang="ts">
  import { statusPresentation } from './runView';
  import { t } from '../locale/language';
  import { onDestroy, onMount } from 'svelte';
  import SystemGraphEditor from './SystemGraphEditor.svelte';
  import AgentProfileEditor from './AgentProfileEditor.svelte';
  import TeamEditor from './TeamEditor.svelte';
  import PipelineEditor from './PipelineEditor.svelte';
  import LaunchCommandEditor from './LaunchCommandEditor.svelte';
  import ScheduleEditor from './ScheduleEditor.svelte';
  import RunInspector from './RunInspector.svelte';
  import RunLauncher from './RunLauncher.svelte';
  import { performRunAction, uncertainTaskMutation, type RunAction } from './runActions';
  import type { RunLaunchSelection } from './runLaunch';
  import { checkedRunSnapshot, createRunLiveUpdates, mergeRunSummaries, mergeSelectedRun, runSummary } from './runUpdates';
  import { orchestrationError, orchestrationHost, OrchestrationOperationError } from '../../host-api/orchestrationClient';
  import type {
    AgentProfile, TeamDefinition, PipelineDefinition, LaunchCommandReference, OrchestrationRunV6,
    OrchestrationClient, OrchestrationCatalogV6, DefinitionSummary, StoredDefinition, RunSummary,
    OrchestrationDefinitionKind, StartRunRequest, TaskRecord, ReconcileUncertainTaskRequest,
    ScheduleDefinition, ScheduleSnapshot,
  } from '../../host-api/orchestrationClient';

  export let modelsFor: (harness: AgentProfile['harness']) => import('../../../../../contracts/workspace-v15').WorkspaceModel[] = () => [];
  export let workspaceId: string;
  export let section: OrchestrationSection = 'agents';
  export let safeMode = false;
  export let onSectionChange: (section: OrchestrationSection) => void = () => {};
  export let onOpenSession: ((sessionId: string) => void) | undefined = undefined;
  export let onDirtyChange: (dirty: boolean) => void = () => {};
  /** A run just started elsewhere (e.g. the pipeline editor) to open in Runs. */
  export let initialRun: OrchestrationRunV6 | undefined = undefined;
  /** Dependency injection is for native-host tests, never a production fake store. */
  export let client: OrchestrationClient = orchestrationHost;

  type EditorBase = { key: string; workspaceId: string };
  type Editor =
    | (EditorBase & { kind: 'profile'; stored?: StoredDefinition<AgentProfile>; profiles: readonly AgentProfile[] })
    | (EditorBase & { kind: 'team'; stored?: StoredDefinition<TeamDefinition>; profiles: readonly AgentProfile[] })
    | (EditorBase & { kind: 'pipeline'; stored?: StoredDefinition<PipelineDefinition>; profiles: readonly AgentProfile[]; teams: readonly TeamDefinition[] })
    | (EditorBase & { kind: 'launch-command'; stored?: StoredDefinition<LaunchCommandReference>; catalog: OrchestrationCatalogV6 })
    | (EditorBase & { kind: 'schedule'; stored?: ScheduleSnapshot; catalog: OrchestrationCatalogV6 });

  let catalog: OrchestrationCatalogV6 | undefined;
  let profileDetails: readonly AgentProfile[] = [];
  let teamDetails: readonly TeamDefinition[] = [];
  let pipelineDetails: readonly PipelineDefinition[] = [];
  let runs: readonly RunSummary[] = [];
  let schedules: readonly ScheduleSnapshot[] = [];
  let selectedRun: OrchestrationRunV6 | undefined;
  let editor: Editor | undefined;
  let launcher: { key: string; workspaceId: string; catalog: OrchestrationCatalogV6; command?: StoredDefinition<LaunchCommandReference>; request?: StartRunRequest } | undefined;
  let launchError: string | undefined;
  let launchRequests = new Set<string>();
  let runMutations = new Map<string, RunAction['type']>();
  let runActionError: { workspaceId: string; runId: string; message: string } | undefined;
  let listBusy = true;
  let streamReady = false;
  let streamError: string | undefined;
  let runUpdateError: { runId: string; message: string } | undefined;
  let manualRunBusy = false;
  let viewGeneration = 0;
  let selectedReadEpoch = 0;
  let unlisten: (() => void) | undefined;
  let unlistenSchedules: (() => void) | undefined;
  let actionBusy = false;
  let listError: string | undefined;
  let editorError: string | undefined;
  let query = '';
  let runStatus = '';
  let pendingRunToOpen: { workspaceId: string; run: OrchestrationRunV6 } | undefined;
  let consumedInitialRun: string | undefined;
  $: if (initialRun && initialRun.id !== consumedInitialRun) { consumedInitialRun = initialRun.id; pendingRunToOpen = { workspaceId, run: initialRun }; }
  let deleteRequest: { workspaceId: string; kind: OrchestrationDefinitionKind | 'schedule'; summary: DefinitionSummary } | undefined;
  let epoch = 0;
  let mounted = false;
  let observedScope = '';
  let dataScope = '';
  const sectionTitles: Record<OrchestrationSection, string> = { systems: 'Systems', agents: 'Agents', teams: 'Teams', pipelines: 'Pipelines', schedules: 'Schedules', runs: 'Runs' };
  const firstTitles = { agents: 'Create your first agent', teams: 'Bring your agents together', pipelines: 'Plan the work', systems: 'Build an agent system', schedules: 'Create your first schedule', runs: 'Start your first run' };
  const firstDescriptions = { agents: 'Choose a model and give it a clear job.', teams: 'Assign roles to saved agents and choose a coordinator.', pipelines: 'Add tasks, choose who does them, and set what runs next.', systems: 'Connect agents and their tasks in one workspace.', schedules: 'Choose a saved launch, timing, and explicit missed-run and overlap policies.', runs: 'Choose a saved team and process to begin.' };
  $: if (pendingRunToOpen && pendingRunToOpen.workspaceId !== workspaceId) pendingRunToOpen = undefined;
  $: scope = `${workspaceId}\u0000${section}`;
  $: if (mounted && streamReady && observedScope !== scope) {
    observedScope = scope;
    viewGeneration += 1;
    selectedReadEpoch += 1;
    query = '';
    launcher = undefined;
    launchError = undefined;
    runActionError = undefined;
    deleteRequest = undefined;
    selectedRun = undefined;
    manualRunBusy = false;
    runUpdateError = undefined;
    if (!editor) void refresh();
  }
  $: staleEditorScope = editor !== undefined && editor.workspaceId !== workspaceId;
  $: launcherBusy = launcher !== undefined && launchRequests.has(launcher.key);
  $: selectedPendingAction = selectedRun === undefined ? undefined : runMutations.get(mutationKey(workspaceId, selectedRun.id));
  $: selectedActionError = selectedRun?.id === runActionError?.runId && workspaceId === runActionError?.workspaceId ? runActionError?.message : undefined;
  $: rows = section === 'agents' ? catalog?.profiles ?? [] : section === 'teams' ? catalog?.teams ?? [] : section === 'pipelines' ? catalog?.pipelines ?? [] : [];
  $: visibleRows = rows.filter((row) => row.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  $: visibleRuns = runs.filter((run) => `${run.teamName} ${run.pipelineName} ${run.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) && (!runStatus || run.status === runStatus));
  $: visibleCommands = (catalog?.launchCommands ?? []).filter((row) => row.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  $: visibleSchedules = schedules.filter((schedule) => schedule.value.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  const liveRuns = createRunLiveUpdates({
    scope: () => ({ workspaceId, generation: viewGeneration, visible: mounted && (section === 'runs' || selectedRun !== undefined) && editor === undefined && launcher === undefined, revision: knownRunRevision }),
    read: (request) => client.orchestration_get_run_v6(request),
    apply: applyRunSnapshot,
    failed: (error, runId) => { runUpdateError = { runId, message: error.message }; },
  });

  onMount(() => { mounted = true; void connectEvents(); void connectScheduleEvents(); });
  onDestroy(() => {
    mounted = false;
    epoch += 1;
    selectedReadEpoch += 1;
    liveRuns.dispose();
    unlisten?.();
    unlistenSchedules?.();
    onDirtyChange(false);
  });

  async function connectEvents(): Promise<void> {
    try {
      const stop = await client.listen((event) => liveRuns.invalidate(event));
      if (!mounted) { stop(); return; }
      unlisten = stop;
    } catch (error) { if (mounted) streamError = orchestrationError(error).message; }
    finally { if (mounted) streamReady = true; }
  }

  async function connectScheduleEvents(): Promise<void> {
    try {
      const stop = await client.listenSchedules((event) => {
        if (mounted && event.workspaceId === workspaceId && section === 'schedules' && editor === undefined) void refresh();
      });
      if (!mounted) { stop(); return; }
      unlistenSchedules = stop;
    } catch {
      // Manual refresh remains available when the schedule invalidation channel is unavailable.
    }
  }

  function knownRunRevision(runId: string): number {
    return Math.max(runs.find((run) => run.id === runId)?.revision ?? -1, selectedRun?.id === runId ? selectedRun.revision : -1);
  }

  function applyRunSnapshot(run: OrchestrationRunV6): void {
    runs = mergeRunSummaries(runs, [runSummary(run)]);
    selectedRun = mergeSelectedRun(selectedRun, run);
    if (runUpdateError?.runId === run.id) runUpdateError = undefined;
  }

  function found<T>(value: T | null): T {
    if (value === null) throw new OrchestrationOperationError('not-found', 'This record is no longer available. Refresh the list.');
    return value;
  }
  async function loadProfiles(targetWorkspace: string, value: OrchestrationCatalogV6): Promise<readonly AgentProfile[]> {
    return Promise.all(value.profiles.map(async (summary) => found(await client.orchestration_get_profile_v6({ workspaceId: targetWorkspace, id: summary.id })).value));
  }
  async function refresh(): Promise<void> {
    const requestEpoch = ++epoch;
    const targetScope = scope;
    const targetWorkspace = workspaceId;
    const targetSection = section;
    if (!targetWorkspace.trim()) { catalog = undefined; runs = []; schedules = []; dataScope = targetScope; listError = undefined; listBusy = false; return; }
    if (dataScope !== targetScope) { catalog = undefined; runs = []; schedules = []; profileDetails = []; }
    listBusy = true;
    listError = undefined;
    try {
      if (targetSection === 'runs') {
        const result = await client.orchestration_list_runs_v6({ workspaceId: targetWorkspace });
        if (!mounted || epoch !== requestEpoch || scope !== targetScope) return;
        runs = mergeRunSummaries(runs, result);
        if (pendingRunToOpen && pendingRunToOpen.workspaceId === workspaceId) { selectedRun = pendingRunToOpen.run; pendingRunToOpen = undefined; }
        runUpdateError = undefined;
      } else if (targetSection === 'schedules') {
        const [latest, stored] = await Promise.all([
          client.orchestration_catalog_v6({ workspaceId: targetWorkspace }),
          client.orchestration_list_schedules_v7({ workspaceId: targetWorkspace }),
        ]);
        if (!mounted || epoch !== requestEpoch || scope !== targetScope) return;
        catalog = latest;
        schedules = stored;
      } else {
        const result = await client.orchestration_catalog_v6({ workspaceId: targetWorkspace });
        const profiles = targetSection === 'agents' ? await loadProfiles(targetWorkspace, result) : [];
        const teams = targetSection === 'teams' ? await Promise.all(result.teams.map(async item => found(await client.orchestration_get_team_v6({ workspaceId: targetWorkspace, id: item.id })).value)) : [];
        const pipelines = targetSection === 'pipelines' ? await Promise.all(result.pipelines.map(async item => found(await client.orchestration_get_pipeline_v6({ workspaceId: targetWorkspace, id: item.id })).value)) : [];
        if (!mounted || epoch !== requestEpoch || scope !== targetScope) return;
        catalog = result;
        profileDetails = profiles; teamDetails = teams; pipelineDetails = pipelines;
      }
      dataScope = targetScope;
    } catch (error) {
      if (mounted && epoch === requestEpoch && scope === targetScope) listError = orchestrationError(error).message;
    } finally { if (mounted && epoch === requestEpoch) listBusy = false; }
  }
  async function openEditor(kind: OrchestrationDefinitionKind | 'schedule', summary: DefinitionSummary | undefined = undefined): Promise<void> {
    if (actionBusy || !workspaceId.trim()) return;
    const targetWorkspace = workspaceId;
    const targetScope = scope;
    actionBusy = true;
    listError = undefined;
    try {
      const latest = await client.orchestration_catalog_v6({ workspaceId: targetWorkspace });
      const base: EditorBase = { key: crypto.randomUUID(), workspaceId: targetWorkspace };
      let next: Editor;
      if (kind === 'profile') {
        const [profiles, stored] = await Promise.all([loadProfiles(targetWorkspace, latest), summary ? client.orchestration_get_profile_v6({ workspaceId: targetWorkspace, id: summary.id }).then(found) : undefined]);
        next = { ...base, kind, profiles, stored };
      } else if (kind === 'team') {
        const [profiles, stored] = await Promise.all([loadProfiles(targetWorkspace, latest), summary ? client.orchestration_get_team_v6({ workspaceId: targetWorkspace, id: summary.id }).then(found) : undefined]);
        next = { ...base, kind, profiles, stored };
      } else if (kind === 'pipeline') {
        const [profiles, teams, stored] = await Promise.all([
          loadProfiles(targetWorkspace, latest),
          Promise.all(latest.teams.map(async (team) => found(await client.orchestration_get_team_v6({ workspaceId: targetWorkspace, id: team.id })).value)),
          summary ? client.orchestration_get_pipeline_v6({ workspaceId: targetWorkspace, id: summary.id }).then(found) : undefined,
        ]);
        next = { ...base, kind, profiles, teams, stored };
      } else if (kind === 'launch-command') {
        const stored = summary ? found(await client.orchestration_get_launch_command_v6({ workspaceId: targetWorkspace, id: summary.id })) : undefined;
        next = { ...base, kind, catalog: latest, stored };
      } else {
        const stored = summary
          ? (await client.orchestration_list_schedules_v7({ workspaceId: targetWorkspace })).find((schedule) => schedule.value.id === summary.id)
          : undefined;
        if (summary && stored === undefined) throw new OrchestrationOperationError('not-found');
        next = { ...base, kind, catalog: latest, stored };
      }
      if (!mounted || scope !== targetScope) return;
      editor = next;
      editorError = undefined;
    } catch (error) { if (mounted && scope === targetScope) listError = orchestrationError(error).message; }
    finally { if (mounted) actionBusy = false; }
  }
  function closeEditor(): void {
    if (actionBusy) return;
    editor = undefined;
    editorError = undefined;
    onDirtyChange(false);
    void refresh();
  }
  async function saveDefinition(value: AgentProfile | TeamDefinition | PipelineDefinition | LaunchCommandReference | ScheduleDefinition): Promise<void> {
    const target = editor;
    if (!target || safeMode || target.workspaceId !== workspaceId || actionBusy) return;
    actionBusy = true;
    editorError = undefined;
    try {
      const common = { workspaceId: target.workspaceId, ...(target.stored ? { expectedRevision: target.stored.revision } : {}) };
      switch (target.kind) {
        case 'profile':
          if (!('harness' in value)) return;
          await client.orchestration_save_profile_v6({ ...common, value }); break;
        case 'team':
          if (!('members' in value)) return;
          await client.orchestration_save_team_v6({ ...common, value }); break;
        case 'pipeline':
          if (!('steps' in value)) return;
          await client.orchestration_save_pipeline_v6({ ...common, value }); break;
        case 'launch-command':
          if (!('teamId' in value)) return;
          await client.orchestration_save_launch_command_v6({ ...common, value }); break;
        case 'schedule':
          if (!('trigger' in value)) return;
          await client.orchestration_save_schedule_v7({ ...common, value }); break;
      }
      if (mounted && editor?.key === target.key) {
        editor = undefined;
        onDirtyChange(false);
        await refresh();
      }
    } catch (error) {
      if (mounted && editor?.key === target.key) editorError = orchestrationError(error).message;
    } finally { if (mounted) actionBusy = false; }
  }
  async function deleteDefinition(): Promise<void> {
    const target = deleteRequest;
    if (!target || safeMode || target.workspaceId !== workspaceId || actionBusy) return;
    actionBusy = true;
    listError = undefined;
    const request = { workspaceId: target.workspaceId, id: target.summary.id, expectedRevision: target.summary.revision };
    try {
      switch (target.kind) {
        case 'profile': await client.orchestration_delete_profile_v6(request); break;
        case 'team': await client.orchestration_delete_team_v6(request); break;
        case 'pipeline': await client.orchestration_delete_pipeline_v6(request); break;
        case 'launch-command': await client.orchestration_delete_launch_command_v6(request); break;
        case 'schedule': await client.orchestration_delete_schedule_v7(request); break;
      }
      if (mounted && deleteRequest === target) { deleteRequest = undefined; await refresh(); }
    } catch (error) { if (mounted && deleteRequest === target) listError = orchestrationError(error).message; }
    finally { if (mounted) actionBusy = false; }
  }
  async function openRun(summary: RunSummary): Promise<void> {
    if (actionBusy) return;
    const targetScope = scope;
    const targetWorkspace = workspaceId;
    const requestEpoch = ++selectedReadEpoch;
    actionBusy = true;
    listError = undefined;
    try {
      const result = await client.orchestration_get_run_v6({ workspaceId: targetWorkspace, runId: summary.id });
      if (!mounted || scope !== targetScope || selectedReadEpoch !== requestEpoch) return;
      selectedRun = checkedRunSnapshot(result, summary.id, Math.max(summary.revision, knownRunRevision(summary.id)));
      applyRunSnapshot(selectedRun);
    } catch (error) { if (mounted && scope === targetScope && selectedReadEpoch === requestEpoch) listError = orchestrationError(error).message; }
    finally { if (mounted) actionBusy = false; }
  }

  function closeRun(): void {
    selectedReadEpoch += 1;
    selectedRun = undefined;
    manualRunBusy = false;
  }

  async function refreshSelectedRun(): Promise<void> {
    const target = selectedRun;
    if (target === undefined || manualRunBusy) return;
    const targetScope = scope;
    const requestEpoch = ++selectedReadEpoch;
    manualRunBusy = true;
    try {
      const result = await client.orchestration_get_run_v6({ workspaceId, runId: target.id });
      if (!mounted || scope !== targetScope || selectedRun?.id !== target.id || selectedReadEpoch !== requestEpoch) return;
      applyRunSnapshot(checkedRunSnapshot(result, target.id, target.revision));
    } catch (error) {
      if (mounted && scope === targetScope && selectedRun?.id === target.id && selectedReadEpoch === requestEpoch) runUpdateError = { runId: target.id, message: orchestrationError(error).message };
    } finally { if (mounted && selectedReadEpoch === requestEpoch) manualRunBusy = false; }
  }
  function mutationKey(targetWorkspace: string, runId: string): string {
    return JSON.stringify([targetWorkspace, runId]);
  }

  function pendingActionLabel(action: RunAction['type']): string {
    switch (action) {
      case 'start': return 'Launch requested. Waiting for the recorded run state.';
      case 'cancel': return 'Cancellation requested. Waiting for proven native stop or recorded uncertainty.';
      case 'retry': return 'New task attempt requested. Waiting for the recorded state. No automatic replay is used.';
      case 'flow': return 'Updating the recorded run state…';
      case 'cancelTask': return 'Stopping the selected task…';
      case 'reconcile': return 'Operator assertion submitted. Waiting for the recorded state; this is not native completion proof.';
      default: { const exhaustive: never = action; return exhaustive; }
    }
  }

  async function openLauncher(command: DefinitionSummary | undefined = undefined): Promise<void> {
    if (safeMode || actionBusy || editor || !workspaceId.trim()) return;
    const targetWorkspace = workspaceId;
    const targetScope = scope;
    actionBusy = true;
    listError = undefined;
    try {
      const [latest, stored] = await Promise.all([
        client.orchestration_catalog_v6({ workspaceId: targetWorkspace }),
        command ? client.orchestration_get_launch_command_v6({ workspaceId: targetWorkspace, id: command.id }).then(found) : undefined,
      ]);
      if (!mounted || scope !== targetScope) return;
      launcher = { key: crypto.randomUUID(), workspaceId: targetWorkspace, catalog: latest, command: stored };
      launchError = undefined;
      selectedRun = undefined;
    } catch (error) { if (mounted && scope === targetScope) listError = orchestrationError(error).message; }
    finally { if (mounted) actionBusy = false; }
  }

  async function startRun(selection: RunLaunchSelection): Promise<void> {
    const target = launcher;
    if (target === undefined || target.workspaceId !== workspaceId || launchRequests.has(target.key) || safeMode) return;
    const targetScope = scope;
    const request = target.request ?? { workspaceId: target.workspaceId, runId: crypto.randomUUID(), ...selection };
    if (request.teamId !== selection.teamId || request.pipelineId !== selection.pipelineId || request.launchCommandId !== selection.launchCommandId) {
      launchError = 'This request already has fixed definitions. Its run ID cannot be reused for different work.';
      return;
    }
    launcher = { ...target, request };
    launchRequests = new Set(launchRequests).add(target.key);
    launchError = undefined;
    const key = mutationKey(target.workspaceId, request.runId);
    runMutations = new Map(runMutations).set(key, 'start');
    try {
      const result = await performRunAction(client, { type: 'start', request }, safeMode);
      if (!mounted || scope !== targetScope || launcher?.key !== target.key) return;
      if (result.type === 'unconfirmed') {
        launchError = `${result.error.message} No run outcome was confirmed. The request ID is kept for an explicit same-request retry.`;
        return;
      }
      launcher = undefined;
      selectedRun = result.run;
      applyRunSnapshot(result.run);
      runActionError = result.actionError === undefined ? undefined : { workspaceId: target.workspaceId, runId: request.runId, message: result.actionError.message };
      // The launch form did not consume live events. This one read closes that transition gap.
      await refreshSelectedRun();
    } finally {
      if (mounted) {
        const remaining = new Map(runMutations); remaining.delete(key); runMutations = remaining;
        const requests = new Set(launchRequests); requests.delete(target.key); launchRequests = requests;
      }
    }
  }

  async function mutateRun(action: RunAction): Promise<void> {
    const target = selectedRun;
    if (target === undefined || action.request.workspaceId !== workspaceId || action.request.runId !== target.id || safeMode) return;
    const key = mutationKey(workspaceId, target.id);
    if (runMutations.has(key)) return;
    const targetScope = scope;
    runMutations = new Map(runMutations).set(key, action.type);
    runActionError = undefined;
    try {
      const result = await performRunAction(client, action, safeMode);
      if (!mounted || scope !== targetScope) return;
      if (result.type === 'recorded') {
        applyRunSnapshot(result.run);
        if (result.actionError !== undefined) runActionError = { workspaceId: action.request.workspaceId, runId: target.id, message: result.actionError.message };
      } else {
        runActionError = { workspaceId: action.request.workspaceId, runId: target.id, message: `${result.error.message} The action outcome is not confirmed. The last loaded run is unchanged.` };
      }
    } finally {
      if (mounted) { const remaining = new Map(runMutations); remaining.delete(key); runMutations = remaining; }
    }
  }

  function cancelSelectedRun(): void {
    if (selectedRun === undefined || selectedRun.status !== 'running' || safeMode) return;
    void mutateRun({ type: 'cancel', request: { workspaceId, runId: selectedRun.id, expectedRunRevision: selectedRun.revision } });
  }

  function retryTask(task: TaskRecord): void {
    const target = selectedRun;
    if (target === undefined || safeMode) return;
    try { void mutateRun({ type: 'retry', request: uncertainTaskMutation(workspaceId, target, task) }); }
    catch (error) { runActionError = { workspaceId, runId: target.id, message: orchestrationError(error).message }; }
  }

  function reconcileTask(task: TaskRecord, resolution: ReconcileUncertainTaskRequest['resolution']): void {
    const target = selectedRun;
    if (target === undefined || safeMode) return;
    try { void mutateRun({ type: 'reconcile', request: { ...uncertainTaskMutation(workspaceId, target, task), resolution } }); }
    catch (error) { runActionError = { workspaceId, runId: target.id, message: orchestrationError(error).message }; }
  }

  async function openScheduledRun(runId: string): Promise<void> {
    if (actionBusy) return;
    actionBusy = true;
    listError = undefined;
    try {
      const result = await client.orchestration_get_run_v6({ workspaceId, runId });
      if (result === null) throw new OrchestrationOperationError('not-found');
      selectedRun = result;
      applyRunSnapshot(result);
    } catch (error) { listError = orchestrationError(error).message; }
    finally { actionBusy = false; }
  }

  async function toggleSchedule(schedule: ScheduleSnapshot): Promise<void> {
    if (safeMode || actionBusy) return;
    actionBusy = true;
    listError = undefined;
    try {
      await client.orchestration_set_schedule_enabled_v7({
        workspaceId,
        id: schedule.value.id,
        expectedRevision: schedule.revision,
        enabled: !schedule.enabled,
      });
      await refresh();
    } catch (error) { listError = orchestrationError(error).message; }
    finally { actionBusy = false; }
  }

  function scheduleSummary(schedule: ScheduleSnapshot): DefinitionSummary {
    return { id: schedule.value.id, name: schedule.value.name, revision: schedule.revision };
  }

  function scheduleTime(value: string | null | undefined): string {
    if (!value) return $t('No further occurrence');
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? $t('Unavailable') : date.toLocaleString();
  }

  function kindForSection(value: OrchestrationSection): OrchestrationDefinitionKind {
    switch (value) { case 'systems': return 'pipeline'; case 'agents': return 'profile'; case 'teams': return 'team'; case 'pipelines': return 'pipeline'; case 'schedules': return 'pipeline'; case 'runs': return 'pipeline'; }
  }
  function harnessName(value: AgentProfile['harness']): string {
    switch (value) { case 'pi': return 'Pi'; case 'prime-agent': return 'Prime Agent'; case 'codex': return 'Codex'; case 'hermes': return 'Hermes'; case 'claude-code': return 'Claude Code'; default: return value; }
  }
</script>

<section class="orchestration-panel" class:graph-view={section === 'systems'} aria-labelledby="orchestration-title">
  {#if section === 'systems'}
    <h1 id="orchestration-title" class="sr-only">{$t('Systems')}</h1>
    {#key workspaceId}<SystemGraphEditor {modelsFor} {workspaceId} {safeMode} {client} {onDirtyChange} onLibrary={() => { section = 'agents'; onSectionChange('agents'); }} onRun={(run) => { pendingRunToOpen = { workspaceId, run }; section = 'runs'; onSectionChange('runs'); }} />{/key}
  {:else}
  {#if safeMode}<p class="notice" role="status">{$t('Safe mode. Definitions and recorded runs are read-only. No native work starts here.')}</p>{/if}
  {#if (section === 'runs' || selectedRun !== undefined) && !editor && !launcher && streamError}<p class="notice" role="status">{$t("Live updates are unavailable. Use Refresh to load recorded state.")} {$t(streamError)}</p>{/if}
  {#if !workspaceId.trim()}
    <div class="empty"><h2 id="orchestration-title">{$t('Choose a project')}</h2><p>{$t('Select a project to read its agent profiles, teams, pipelines and runs.')}</p></div>
  {:else if editor}
    <h1 id="orchestration-title" class="sr-only">{$t('Definition editor')}</h1>
    {#if staleEditorScope}<p class="notice" role="status">{$t('This draft belongs to the previous project. Return to that project to save, or cancel this editor.')}</p>{/if}
    {#key editor.key}
      {#if editor.kind === 'profile'}<AgentProfileEditor {workspaceId} profile={editor.stored?.value} profiles={editor.profiles} busy={actionBusy} error={editorError} readOnly={safeMode || staleEditorScope} onSave={(value) => void saveDefinition(value)} onCancel={closeEditor} {onDirtyChange} />
      {:else if editor.kind === 'team'}<TeamEditor team={editor.stored?.value} profiles={editor.profiles} busy={actionBusy} error={editorError} readOnly={safeMode || staleEditorScope} onSave={(value) => void saveDefinition(value)} onCancel={closeEditor} {onDirtyChange} />
      {:else if editor.kind === 'pipeline'}<PipelineEditor pipeline={editor.stored?.value} profiles={editor.profiles} teams={editor.teams} busy={actionBusy} error={editorError} readOnly={safeMode || staleEditorScope} onSave={(value) => void saveDefinition(value)} onCancel={closeEditor} {onDirtyChange} />
      {:else if editor.kind === 'launch-command'}<LaunchCommandEditor command={editor.stored?.value} teams={editor.catalog.teams} pipelines={editor.catalog.pipelines} busy={actionBusy} error={editorError} readOnly={safeMode || staleEditorScope} onSave={(value) => void saveDefinition(value)} onCancel={closeEditor} {onDirtyChange} />
      {:else}<ScheduleEditor onCreateSystem={() => { closeEditor(); section = 'systems'; onSectionChange('systems'); }} schedule={editor.stored} launchCommands={editor.catalog.launchCommands} busy={actionBusy} error={editorError} readOnly={safeMode || staleEditorScope} onSave={(value) => void saveDefinition(value)} onCancel={closeEditor} {onDirtyChange} />{/if}
    {/key}
  {:else if launcher}
    <h1 id="orchestration-title" class="sr-only">{$t('Launch a recorded run')}</h1>
    {#if launcher.request}<p class="hint">{$t('Requested run: ')}<code>{launcher.request.runId}</code>{$t(". Leaving this view does not cancel it.")}</p>{/if}
    {#key launcher.key}<RunLauncher teams={launcher.catalog.teams} pipelines={launcher.catalog.pipelines} command={launcher.command} busy={launcherBusy} error={launchError} readOnly={safeMode || launcher.workspaceId !== workspaceId} locked={launcher.request !== undefined} onStart={(selection) => void startRun(selection)} onCancel={() => { if (!launcherBusy) { launcher = undefined; launchError = undefined; } }} />{/key}
  {:else if selectedRun}
    <h1 id="orchestration-title" class="sr-only">{$t('Run details')}</h1>
    <div class="page-actions"><button type="button" class="secondary" onclick={() => void refreshSelectedRun()} disabled={manualRunBusy} aria-label={$t('Refresh run')}>{manualRunBusy ? $t('Refreshing…') : $t('Refresh run')}</button></div>
    {#if runUpdateError?.runId === selectedRun.id}<div class="error" role="alert"><strong>{$t('Could not refresh the recorded run')}</strong><p>{$t(runUpdateError.message)}</p></div>{/if}
    {#if selectedPendingAction !== undefined}<p class="notice" role="status">{$t(pendingActionLabel(selectedPendingAction))}</p>{/if}
    <RunInspector onCancelTask={safeMode || selectedPendingAction ? undefined : (stepId) => { if (selectedRun) void mutateRun({type:'cancelTask',request:{workspaceId,runId:selectedRun.id,expectedRunRevision:selectedRun.revision,stepId}}); }} onFlow={safeMode || selectedPendingAction ? undefined : (action) => { if (selectedRun) void mutateRun({ type:'flow', request:{ workspaceId, runId:selectedRun.id, expectedRunRevision:selectedRun.revision, action } }); }} {workspaceId} run={selectedRun} {onOpenSession} onClose={closeRun} busy={selectedPendingAction !== undefined} error={selectedActionError} onCancelRun={safeMode ? undefined : cancelSelectedRun} onRetryTask={safeMode ? undefined : retryTask} onReconcileTask={safeMode ? undefined : reconcileTask} />
  {:else}
    <header class="page-header"><div><h1 id="orchestration-title">{$t(sectionTitles[section])}</h1></div><div class="page-actions"><button type="button" class="secondary" onclick={() => void refresh()} disabled={listBusy || actionBusy} aria-label={$t("Refresh {0}", [$t(sectionTitles[section]).toLowerCase()])}>{listBusy ? $t('Refreshing…') : $t('Refresh')}</button>{#if section !== 'runs' && !safeMode}<button type="button" class="primary" disabled={actionBusy || listBusy} onclick={() => void openEditor(section === 'schedules' ? 'schedule' : kindForSection(section))}>{$t(section === 'agents' ? 'Create profile' : section === 'teams' ? 'Create team' : section === 'schedules' ? 'Create schedule' : 'Create pipeline')}</button>{/if}{#if section === 'runs'}<button type="button" class="primary" disabled={safeMode || actionBusy || listBusy} onclick={() => void openLauncher()}>{$t('Start run')}</button>{/if}</div></header>
    <label class="search"><span>{$t("Search")} {$t(sectionTitles[section])}</span><input type="search" bind:value={query} placeholder={$t("Find {0}…", [$t(sectionTitles[section]).toLowerCase()])} /></label>
    {#if section === 'runs'}<label>{$t('Status')}<select aria-label={$t('Filter runs')} bind:value={runStatus}><option value="">{$t('All runs')}</option>{#each ['running','succeeded','failed','cancelled','uncertain'] as status}<option value={status}>{$t(status)}</option>{/each}</select></label>{/if}
    {#if listError}<div class="error" role="alert"><strong>{$t('Could not complete the workspace action')}</strong><p>{$t(listError)}</p><button type="button" onclick={() => void refresh()} disabled={listBusy || actionBusy}>{$t('Try again')}</button></div>{/if}
    {#if section === 'runs' && runUpdateError}<div class="error" role="alert"><strong>{$t('Could not refresh a recorded run')}</strong><p>{$t(runUpdateError.message)}</p><button type="button" onclick={() => void refresh()} disabled={listBusy}>{$t('Refresh runs')}</button></div>{/if}
    {#if deleteRequest}<div class="delete-confirm" role="group" aria-label={$t('Confirm definition deletion')}><strong>{$t("Delete")} {deleteRequest.summary.name}?</strong><p>{$t('Delete this definition? Existing sessions and recorded runs are kept.')}</p><div class="page-actions"><button type="button" class="secondary" disabled={actionBusy} onclick={() => deleteRequest = undefined}>{$t('Keep definition')}</button><button type="button" class="danger" disabled={actionBusy || safeMode} onclick={() => void deleteDefinition()}>{actionBusy ? $t('Deleting…') : $t('Delete definition')}</button></div></div>{/if}
    {#if listBusy && dataScope !== scope}<p class="loading" role="status">{$t("Loading local")} {$t(sectionTitles[section])}…</p>
    {:else if dataScope === scope}
      {#if section === 'runs'}
        {#if visibleRuns.length === 0}<div class="empty"><h2>{query.trim() ? $t('No matching runs') : $t('No runs recorded')}</h2><p>{query.trim() ? $t('Change the search to see other runs.') : $t('Choose Start run to use a saved team and pipeline. Only recorded runs appear here.')}</p></div>
        {:else}<ul class="definition-list" aria-label={$t('Recorded runs')}>{#each visibleRuns as run (run.id)}<li><button type="button" class="row-open" onclick={() => void openRun(run)} disabled={actionBusy}><strong>{run.pipelineName}</strong><span>{run.teamName} · {$t(statusPresentation(run.status).label)} · {run.id}</span></button></li>{/each}</ul>{/if}
      {:else if section === 'schedules'}
        {#if visibleSchedules.length === 0}<div class="empty"><h2>{query.trim() ? $t('No matching schedules') : $t(firstTitles.schedules)}</h2><p>{query.trim() ? $t('Change the search to see other schedules.') : safeMode ? $t('Create actions are disabled in safe mode.') : $t(firstDescriptions.schedules)}</p>{#if !safeMode && !query.trim()}<button type="button" class="primary empty-action" onclick={() => void openEditor('schedule')}>{$t('Create schedule')}</button>{/if}</div>
        {:else}<ul class="definition-list" aria-label={$t('Schedules')}>{#each visibleSchedules as schedule (schedule.value.id)}<li><button type="button" class="row-open" onclick={() => void openEditor('schedule', scheduleSummary(schedule))} disabled={actionBusy}><strong>{schedule.value.name}</strong><span>{schedule.enabled ? $t('Enabled') : $t('Disabled')} · {$t('Next')}: {scheduleTime(schedule.nextDueAt)}</span>{#if schedule.lastOccurrence}<span>{$t('Last')}: {$t(schedule.lastOccurrence.outcome)}{schedule.lastOccurrence.failureCode ? ` · ${$t(schedule.lastOccurrence.failureCode)}` : ''}</span>{/if}</button>{#if schedule.lastOccurrence?.runId}<button type="button" class="secondary" disabled={actionBusy} onclick={() => void openScheduledRun(schedule.lastOccurrence?.runId ?? '')}>{$t('Open run')}</button>{/if}{#if !safeMode}<button type="button" class="secondary" disabled={actionBusy} aria-label={$t(schedule.enabled ? 'Disable {0}' : 'Enable {0}', [schedule.value.name])} onclick={() => void toggleSchedule(schedule)}>{schedule.enabled ? $t('Disable') : $t('Enable')}</button><button type="button" class="row-delete" disabled={actionBusy} aria-label={$t('Delete {0}', [schedule.value.name])} onclick={() => deleteRequest = { workspaceId, kind: 'schedule', summary: scheduleSummary(schedule) }}>{$t('Delete')}</button>{/if}</li>{/each}</ul>{/if}
      {:else}
        {#if visibleRows.length === 0}<div class="empty"><h2>{query.trim() ? $t('No matching definitions') : $t(firstTitles[section])}</h2><p>{query.trim() ? $t('Change the search to see other definitions.') : safeMode ? $t('Create actions are disabled in safe mode.') : $t(firstDescriptions[section])}</p>{#if !safeMode && !query.trim()}<button type="button" class="primary empty-action" onclick={() => void openEditor(kindForSection(section))}>{$t(section === 'agents' ? 'Create agent' : section === 'teams' ? 'Create team' : 'Create pipeline')}</button>{/if}</div>
        {:else}<ul class="definition-list" aria-label={$t("{0} definitions", [$t(sectionTitles[section])])}>{#each visibleRows as row (row.id)}{@const profile = section === 'agents' ? profileDetails.find((item) => item.id === row.id) : undefined}<li><button type="button" class="row-open" onclick={() => void openEditor(kindForSection(section), row)} disabled={actionBusy}><strong>{row.name}</strong>{#if section === 'teams'}{@const team = teamDetails.find(item => item.id === row.id)}<span>{$t('Members: {0}', [team?.members.length ?? 0])} · {$t('Coordinator')}: {team?.orchestratorMemberId || $t('Not selected')}</span>{:else if section === 'pipelines'}{@const pipeline = pipelineDetails.find(item => item.id === row.id)}<span>{$t('Tasks: {0}', [pipeline?.steps.length ?? 0])} · {$t('Dependencies: {0}', [pipeline?.steps.reduce((sum, step) => sum + step.dependencyStepIds.length, 0) ?? 0])}</span>{/if}{#if profile}<span>{harnessName(profile.harness)} · {profile.model}</span>{#if profile.whenToCall}<span>{profile.whenToCall}</span>{/if}{/if}{#if profile?.toolPolicy.rules.some((rule) => rule.mandatory && (rule.enforcement === 'advisory' || rule.enforcement === 'unsupported'))}<span class="policy-warning">{$t('Unsupported mandatory policy — launch blocked')}</span>{/if}</button>{#if !safeMode}<button type="button" class="row-delete" disabled={actionBusy} aria-label={$t("Delete {0}", [row.name])} onclick={() => deleteRequest = { workspaceId, kind: kindForSection(section), summary: row }}>{$t('Delete')}</button>{/if}</li>{/each}</ul>{/if}
        {#if section === 'pipelines'}<details class="commands"><summary>{$t('Saved launches')} <span>{catalog?.launchCommands.length ?? 0}</span></summary><section aria-labelledby="launch-commands-title"><header class="page-header"><div><h2 id="launch-commands-title">{$t('Launch commands')}</h2><p>{$t('Save a team and pipeline together for reuse.')}</p></div>{#if !safeMode}<button type="button" class="secondary" disabled={actionBusy || listBusy} onclick={() => void openEditor('launch-command')}>{$t('Create launch command')}</button>{/if}</header>{#if visibleCommands.length === 0}<p class="hint">{query.trim() ? $t('No matching launch commands.') : $t('No launch commands saved.')}</p>{:else}<ul class="definition-list" aria-label={$t('Launch commands')}>{#each visibleCommands as command (command.id)}<li><button type="button" class="row-open" onclick={() => void openEditor('launch-command', command)} disabled={actionBusy}><strong>{command.name}</strong><span>{$t('Saved team and pipeline')}</span></button><button type="button" class="secondary" aria-label={$t("Launch {0}", [command.name])} disabled={safeMode || actionBusy} onclick={() => void openLauncher(command)}>{$t('Launch')}</button>{#if !safeMode}<button type="button" class="row-delete" disabled={actionBusy} aria-label={$t("Delete {0}", [command.name])} onclick={() => deleteRequest = { workspaceId, kind: 'launch-command', summary: command }}>{$t('Delete')}</button>{/if}</li>{/each}</ul>{/if}</section></details>{/if}
      {/if}
    {/if}
    {#if actionBusy}<p class="loading" role="status">{$t('Loading or saving the selected record…')}</p>{/if}
  {/if}
  {/if}
</section>

<style>
  .empty { border: 1px dashed var(--piui-border); border-radius: var(--piui-radius-lg); padding: var(--piui-space-8) !important; background: var(--piui-bg-raised); margin: var(--piui-space-5) 0; }
  .empty-action { justify-self: start; margin-top: var(--piui-space-4); }
  details.commands > summary { cursor: pointer; font-weight: 600; padding: 16px 0; border-top: 1px solid var(--piui-border); }
  details.commands > summary span { color: var(--piui-text-muted); margin-left: 8px; font-variant-numeric: tabular-nums; }
  .orchestration-panel.graph-view { height:100%; padding:0; }
  .orchestration-panel { min-width: 0; padding: var(--piui-space-6); color: var(--piui-text); }
  .page-header, .page-actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--piui-space-3); }.page-header { justify-content: space-between; margin-bottom: var(--piui-space-5); }.page-header h1, .page-header h2, p { margin: 0; }.page-header h1 { font-size: 20px; letter-spacing: -.025em; }.page-header h2 { font-size: 18px; }.page-header p { margin-top: var(--piui-space-2); color: var(--piui-text-muted); font-size: 13px; line-height: 1.5; }
  button { min-height: 32px; padding: var(--piui-space-2) var(--piui-space-3); border-radius: var(--piui-radius-sm); font-size: 13px; }.secondary { border: 1px solid var(--piui-border); background: var(--piui-surface-1); color: var(--piui-text); }.primary { background: var(--piui-action); color: var(--piui-action-ink); font-weight: 600; }.danger { background: var(--piui-danger-surface); color: var(--piui-danger-text); border: 1px solid var(--piui-danger-border); }button:disabled { opacity: .6; }button:hover:not(:disabled):not(.primary):not(.danger) { background: var(--piui-surface-2); }
  .definition-list li:hover { background:var(--piui-bg-raised); }
  .search { display: grid; gap: var(--piui-space-2); margin-bottom: var(--piui-space-4); font-size: 12px; font-weight: 600; color: var(--piui-text-muted); }.search input { width: 100%; min-width: 0; padding: var(--piui-space-3); border: 1px solid var(--piui-border); border-radius: var(--piui-radius-sm); background: var(--piui-surface-1); color: var(--piui-text); font-size: 13px; }
  .definition-list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--piui-border); }.definition-list li { border-radius:var(--piui-radius-sm); display: flex; align-items: center; gap: var(--piui-space-2); border-bottom: 1px solid var(--piui-border-subtle); }.row-open { flex: 1 1 0; min-width: 0; display: grid; gap: var(--piui-space-1); padding: var(--piui-space-4) var(--piui-space-2); background: transparent; color: var(--piui-text); text-align: left; }.row-open strong { overflow-wrap: anywhere; font-size: 14px; font-weight: 600; }.row-open span { color: var(--piui-text-muted); font-size: 12px; overflow-wrap: anywhere; }.row-delete { flex: 0 0 auto; background: transparent; color: var(--piui-text-muted); }.row-open .policy-warning { color: var(--piui-warning-text); }
  .empty { display: grid; gap: var(--piui-space-2); padding: var(--piui-space-6) 0; }.empty h2 { margin: 0; font-size: 17px; }.empty p, .loading, .hint { color: var(--piui-text-muted); font-size: 13px; line-height: 1.5; }.loading { margin: var(--piui-space-4) 0; }.commands { margin-top: var(--piui-space-7); }.commands .hint { margin-top: var(--piui-space-3); }
  .notice, .error, .delete-confirm { padding: var(--piui-space-4); margin-bottom: var(--piui-space-4); border-radius: var(--piui-radius-sm); font-size: 13px; line-height: 1.5; }.notice, .delete-confirm { background: var(--piui-warning-surface); color: var(--piui-warning-text); }.error { border: 1px solid var(--piui-danger-border); background: var(--piui-danger-surface); color: var(--piui-danger-text); }.error p, .delete-confirm p { margin: var(--piui-space-2) 0; }.error button { border: 1px solid var(--piui-danger-border); background: transparent; color: inherit; }
  .sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  @media (max-width: 700px) { .orchestration-panel { padding: var(--piui-space-4); } }
</style>
