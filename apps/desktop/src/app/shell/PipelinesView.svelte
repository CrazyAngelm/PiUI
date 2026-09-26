<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Folder from '@lucide/svelte/icons/folder';
  import Library from '@lucide/svelte/icons/library';
  import { t } from '../../features/locale/language';
  import type { OrchestrationRunV6 } from '../../host-api/orchestrationClient';
  import { EmptyState, Menu, Picker, Segmented, Skeleton, type PickerItem } from '../../lib/ui';
  import type { PipelineSection } from '../workspaceStore.svelte';
  import { useWorkspace } from './context';

  interface Props {
    section: PipelineSection;
  }
  let { section }: Props = $props();
  const store = useWorkspace();

  // The graph editor is rebuilt on Svelte Flow; runs, schedules and the
  // library still use the existing orchestration contribution.
  const editor = import('../pipelines/PipelineEditor.svelte');
  const panel = import('../../features/orchestration/OrchestrationPanel.svelte');
  let epoch = $state(0);
  let startedRun = $state.raw<OrchestrationRunV6 | undefined>();

  const projects = $derived(store.catalog.workspaces.filter((item) => !item.missing));
  const workspace = $derived(store.selectedWorkspace);
  const projectItems = $derived<PickerItem[]>(
    projects.map((item) => ({ value: item.id, label: item.personal ? $t('Personal chats') : item.name })),
  );
  type MainSection = 'systems' | 'runs' | 'schedules';
  const mainSection = $derived<MainSection>(section === 'runs' || section === 'schedules' ? section : 'systems');
  const librarySection = $derived(section === 'agents' || section === 'teams' || section === 'pipelines');

  function setSection(next: PipelineSection): void {
    if (next === section) return;
    store.navigate({ name: 'pipelines', section: next });
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
    setSection('runs');
  }
</script>

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
    <Segmented
      label={$t('Pipeline sections')}
      value={librarySection ? 'systems' : mainSection}
      options={[
        { value: 'systems', label: $t('Editor') },
        { value: 'runs', label: $t('Runs') },
        { value: 'schedules', label: $t('Automations') },
      ]}
      onValueChange={(value) => setSection(value)}
    />
    <div class="spacer"></div>
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
  </header>

  <div class="body">
    {#if !workspace}
      <EmptyState title={$t('Choose a project')} description={$t('Pipelines belong to a project folder.')} />
    {:else if !workspace.personal && workspace.trust !== 'trusted'}
      <EmptyState title={$t('This folder is restricted')} description={$t('Trust the folder from the sidebar to build and run pipelines in it.')} />
    {:else if section === 'systems'}
      {#await editor}
        <div class="loading"><Skeleton lines={5} /></div>
      {:then module}
        {#key `${workspace.id}:${epoch}`}
          <module.default
            workspaceId={workspace.id}
            safeMode={store.safeMode}
            onDirtyChange={(dirty) => (store.pipelineDirty = dirty)}
            onRun={opened}
            onLibrary={() => setSection('agents')}
          />
        {/key}
      {:catch}
        <EmptyState title={$t('Pipelines are unavailable')} description={$t('Chats and history still work.')} />
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
        <EmptyState title={$t('Pipelines are unavailable')} description={$t('Chats and history still work.')} />
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
