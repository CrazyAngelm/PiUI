<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Folder from '@lucide/svelte/icons/folder';
  import Library from '@lucide/svelte/icons/library';
  import { t } from '../../features/locale/language';
  import { orchestrationHost, type OrchestrationRunV6 } from '../../host-api/orchestrationClient';
  import { Button, EmptyState, Menu, Picker, Skeleton, type PickerItem } from '../../lib/ui';
  import type { PipelineSection } from '../workspaceStore.svelte';
  import type { AgentGraph } from '../../features/orchestration/agentGraph';
  import { pendingDrafts, type DraftSource } from '../pipelines/pendingDraft.svelte';
  import { useWorkspace } from './context';

  interface Props {
    section: PipelineSection;
    runId?: string;
  }
  let { section, runId }: Props = $props();
  const store = useWorkspace();

  // The graph editor is rebuilt on Svelte Flow; runs, schedules and the
  // library still use the existing orchestration contribution. Each part is
  // its own chunk, started now and started again from "Retry" after a failure.
  const chunks = {
    editor: () => import('../pipelines/PipelineEditor.svelte'),
    runs: () => import('../runs/RunsView.svelte'),
    automations: () => import('../automations/AutomationsView.svelte'),
    library: () => import('../../features/orchestration/OrchestrationPanel.svelte'),
  };
  let editor = $state.raw(chunks.editor());
  let runsView = $state.raw(chunks.runs());
  let automationsView = $state.raw(chunks.automations());
  let panel = $state.raw(chunks.library());
  let epoch = $state(0);
  let startedRun = $state.raw<OrchestrationRunV6 | undefined>();

  const projects = $derived(store.catalog.workspaces.filter((item) => !item.missing));
  const workspace = $derived(store.selectedWorkspace);
  const projectItems = $derived<PickerItem[]>(
    projects.map((item) => ({ value: item.id, label: item.personal ? $t('Personal chats') : item.name })),
  );
  const librarySection = $derived(section === 'agents' || section === 'teams' || section === 'pipelines');
  // The Library menu belongs to the editor and the library lists; Runs and Automations have no use for it.
  const showLibrary = $derived(section !== 'runs' && section !== 'schedules');

  // "Edit pipeline" from a run opens that run's saved pipeline in the editor.
  let editCommand = $state<string | undefined>();
  // "Debug in editor" opens a past run as a new unsaved draft instead.
  let editDraft = $state.raw<AgentGraph | undefined>();
  let draftSource = $state<DraftSource>('run');
  // The sidebar navigates without this view: leaving the editor by any route drops what it was asked to open.
  $effect(() => {
    if (section === 'systems') return;
    editCommand = undefined;
    editDraft = undefined;
  });
  // A draft offered by another screen (a template chosen in a chat) opens once.
  $effect(() => {
    const id = workspace?.id;
    const pending = id ? pendingDrafts.take(id) : undefined;
    if (!pending) return;
    editCommand = undefined;
    editDraft = pending.graph;
    draftSource = pending.source;
    epoch += 1;
  });
  function setSection(next: PipelineSection): void {
    if (next === section) return;
    store.navigate({ name: 'pipelines', section: next });
  }
  /** The chunk of the open section failed to load: try it again. */
  function retryChunk(): void {
    if (section === 'runs') runsView = chunks.runs();
    else if (section === 'schedules') automationsView = chunks.automations();
    else if (section === 'systems') editor = chunks.editor();
    else panel = chunks.library();
  }
  function editPipeline(commandId: string | undefined): void {
    editCommand = commandId;
    editDraft = undefined;
    setSection('systems');
  }
  function debugRun(draft: AgentGraph): void {
    editCommand = undefined;
    editDraft = draft;
    draftSource = 'run';
    setSection('systems');
  }
  function selectProject(id: string): void {
    store.guard(() => {
      store.pipelineDirty = false;
      store.selectWorkspace(id);
      startedRun = undefined;
      epoch += 1;
    });
  }
  function opened(run: OrchestrationRunV6): void {
    startedRun = run;
    store.pipelineDirty = false;
    store.navigate({ name: 'pipelines', section: 'runs', runId: run.id });
  }
</script>

{#snippet unavailable()}
  <EmptyState title={$t('Pipelines are unavailable')} description={$t('Chats and history still work.')}>
    {#snippet actions()}
      <Button size="sm" onclick={retryChunk}>{$t('Retry')}</Button>
    {/snippet}
  </EmptyState>
{/snippet}

<section class="pipelines" aria-labelledby="pipelines-title">
  <header class="head">
    <h1 id="pipelines-title" class="visually-hidden">{$t('Pipelines')}</h1>
    <Picker items={projectItems} value={workspace?.id} label={$t('Project')} searchPlaceholder={$t('Search projects')} onSelect={selectProject}>
      {#snippet trigger(props)}
        <button type="button" class="project" {...props}>
          <Folder size={15} />
          <span>{workspace ? (workspace.personal ? $t('Personal chats') : workspace.name) : $t('Choose project')}</span>
          <ChevronDown size={12} />
        </button>
      {/snippet}
    </Picker>
    <div class="spacer"></div>
    {#if showLibrary}
      <Menu
        align="end"
        items={[
          { label: $t('Agents'), checked: section === 'agents', onSelect: () => setSection('agents') },
          { label: $t('Teams'), checked: section === 'teams', onSelect: () => setSection('teams') },
          { label: $t('Step lists'), checked: section === 'pipelines', onSelect: () => setSection('pipelines') },
        ]}
      >
        {#snippet trigger(props)}
          <button type="button" class="library" class:library--active={librarySection} {...props}>
            <Library size={15} />
            <span>{$t('Library')}</span>
            <ChevronDown size={12} />
          </button>
        {/snippet}
      </Menu>
    {/if}
  </header>

  <div class="body">
    {#if !workspace}
      <EmptyState title={$t('Choose a project')} description={$t('Pipelines belong to a project folder.')} />
    {:else if !workspace.personal && workspace.trust !== 'trusted'}
      <EmptyState title={$t('This folder is restricted')} description={$t('Trust the folder from the sidebar to build and run pipelines in it.')} />
    {:else if section === 'runs'}
      {#await runsView}
        <div class="loading"><Skeleton lines={5} /></div>
      {:then module}
        {#key `${workspace.id}:${epoch}`}
          <module.default
            workspaceId={workspace.id}
            safeMode={store.safeMode}
            client={orchestrationHost}
            {runId}
            initialRun={startedRun?.id === runId ? startedRun : undefined}
            onOpenRun={(id) => store.navigate({ name: 'pipelines', section: 'runs', runId: id })}
            onEdit={editPipeline}
            onDebug={debugRun}
          />
        {/key}
      {:catch}
        {@render unavailable()}
      {/await}
    {:else if section === 'schedules'}
      {#await automationsView}
        <div class="loading"><Skeleton lines={5} /></div>
      {:then module}
        {#key `${workspace.id}:${epoch}`}
          <module.default
            workspaceId={workspace.id}
            safeMode={store.safeMode}
            client={orchestrationHost}
            onOpenRun={(id) => store.navigate({ name: 'pipelines', section: 'runs', runId: id })}
            onEditPipelines={() => setSection('systems')}
          />
        {/key}
      {:catch}
        {@render unavailable()}
      {/await}
    {:else if section === 'systems'}
      {#await editor}
        <div class="loading"><Skeleton lines={5} /></div>
      {:then module}
        {#key `${workspace.id}:${epoch}`}
          <module.default
            workspaceId={workspace.id}
            safeMode={store.safeMode}
            openCommandId={editCommand}
            openDraft={editDraft}
            {draftSource}
            onDirtyChange={(dirty) => (store.pipelineDirty = dirty)}
            onRun={opened}
          />
        {/key}
      {:catch}
        {@render unavailable()}
      {/await}
    {:else}
      {#await panel}
        <div class="loading"><Skeleton lines={5} /></div>
      {:then module}
        {#key `${workspace.id}:${epoch}`}
          <module.default
            modelsFor={(harness) => store.modelsFor(harness)}
            workspaceId={workspace.id}
            {section}
            safeMode={store.safeMode}
            initialRun={startedRun}
            onSectionChange={(next) => setSection(next)}
            onOpenSession={(sessionId) => void store.openSession(sessionId)}
            onDirtyChange={(dirty) => (store.pipelineDirty = dirty)}
          />
        {/key}
      {:catch}
        {@render unavailable()}
      {/await}
    {/if}
  </div>
</section>

<style>
  .pipelines {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--piui-space-3);
    height: var(--piui-header-height);
    padding: 0 var(--piui-space-3);
    border-bottom: 1px solid var(--piui-border-subtle);
    flex: none;
  }
  .spacer {
    flex: 1;
  }
  .project,
  .library {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text);
    font-weight: var(--piui-weight-medium);
  }
  .library {
    color: var(--piui-text-muted);
    font-weight: var(--piui-weight-regular);
  }
  .project:hover,
  .library:hover,
  .library--active {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .loading {
    padding: var(--piui-space-8);
  }
</style>
