<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Play from '@lucide/svelte/icons/play';
  import Save from '@lucide/svelte/icons/save';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import Plus from '@lucide/svelte/icons/plus';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import FilePlus from '@lucide/svelte/icons/file-plus';
  import Upload from '@lucide/svelte/icons/upload';
  import Download from '@lucide/svelte/icons/download';
  import Bot from '@lucide/svelte/icons/bot';
  import Split from '@lucide/svelte/icons/split';
  import Code from '@lucide/svelte/icons/code';
  import MessageSquareText from '@lucide/svelte/icons/message-square-text';
  import Library from '@lucide/svelte/icons/library';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import Workflow from '@lucide/svelte/icons/workflow';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import { remoteHarnessSupported } from './remotePolicy';
  import { remoteMode, hostSupports } from '../nano/remoteMode';
  import { t } from '../../features/locale/language';
  import { nanoAccount } from '../nano/nanoAccount.svelte';
  import { Badge, Button, Dialog, Menu, Picker, Spinner, matchesShortcut, toasts, type PickerItem } from '../../lib/ui';
  import type { AgentProfile, OrchestrationRunV6, RunInputValue } from '../../host-api/orchestrationClient';
  import { orchestrationHost } from '../../host-api/orchestrationClient';
  import FlowCanvas from './canvas/FlowCanvas.svelte';
  import type { FlowApi } from './canvas/FlowBridge.svelte';
  import NodeInspector from './NodeInspector.svelte';
  import StartInspector from './StartInspector.svelte';
  import { profileForHarness } from '../../harness-adapters/normalize';
  import { harnessConfiguration } from '../../harness-adapters';
  import RunInputsDialog from './inputs/RunInputsDialog.svelte';
  import OutputInspector from './OutputInspector.svelte';
  import { PipelineEditorStore } from './editorStore.svelte';
  import { forgetLastPipeline, readLastPipeline } from './lastPipeline';
  import { TEMPLATES, buildTemplate, type TemplateId } from './templates';
  import Blocks from '@lucide/svelte/icons/blocks';
  import PluginTemplates from '../plugins/PluginTemplates.svelte';
  import { pluginNodeMenu } from '../plugins/pluginNodes';
  import { pluginRegistry } from '../plugins/pluginRegistry.svelte';
  import { useWorkspace } from '../shell/context';
  import type { AgentGraph } from '../../features/orchestration/agentGraph';
  import type { DraftSource } from './pendingDraft.svelte';
  import { graphFromTemplate, withDefaultModels } from '../chatPipelines/templateLibrary';
  import { chatPipelines } from '../chatPipelines/chatPipelines.svelte';
  import SaveTemplateDialog from '../chatPipelines/SaveTemplateDialog.svelte';
  import BookmarkPlus from '@lucide/svelte/icons/bookmark-plus';
  import type { PipelineTemplateV1 } from '../../host-api/pipelineLibraryClient';

  interface Props {
    workspaceId: string;
    safeMode: boolean;
    /** A saved pipeline to open on mount, e.g. from a run. */
    openCommandId?: string;
    /** A new unsaved draft to open on mount, e.g. a past run to debug (wins over `openCommandId`). */
    openDraft?: AgentGraph;
    /** Where `openDraft` came from; a template's empty models are filled in. */
    draftSource?: DraftSource;
    onDirtyChange: (dirty: boolean) => void;
    onRun: (run: OrchestrationRunV6) => void;
  }
  let { workspaceId, safeMode, openCommandId, openDraft, draftSource = 'run', onDirtyChange, onRun }: Props = $props();
  const workspace = useWorkspace();
  const editor = new PipelineEditorStore(untrack(() => workspaceId), untrack(() => safeMode));

  let api = $state.raw<FlowApi | undefined>();
  let filePicker = $state<HTMLInputElement | null>(null);
  let canvasElement = $state<HTMLDivElement | null>(null);
  let addMenuOpen = $state(false);
  let inputsOpen = $state(false);
  let saveTemplateOpen = $state(false);
  // Until the saved pipelines are listed, a remembered one may still open: no start screen flashes by.
  let restoring = $state(!untrack(() => openDraft) && !untrack(() => openCommandId) && readLastPipeline(untrack(() => workspaceId)) !== undefined);
  const projectName = $derived.by(() => {
    const project = workspace.catalog.workspaces.find((item) => item.id === workspaceId);
    return project?.personal ? $t('Personal chats') : (project?.name ?? $t('This project'));
  });
  const userTemplates = $derived(chatPipelines.libraries[workspaceId]?.templates ?? []);
  const ASSISTANT_KEY = 'piui.pipeline.assistant.open';
  let assistantOpen = $state(!remoteMode && readAssistantOpen());
  let assistantModule = $state<Promise<typeof import('./assistant/AssistantPanel.svelte')> | undefined>();

  function readAssistantOpen(): boolean {
    try {
      return localStorage.getItem(ASSISTANT_KEY) === 'true';
    } catch {
      return false;
    }
  }
  function setAssistant(open: boolean): void {
    assistantOpen = open;
    try {
      localStorage.setItem(ASSISTANT_KEY, String(open));
    } catch {
      // Panel state is a convenience only.
    }
  }
  $effect(() => {
    if (assistantOpen && !assistantModule) assistantModule = import('./assistant/AssistantPanel.svelte');
  });

  const source = $derived(editor.sourceDefinition);
  const members = $derived(new Map(source?.team.members.map((member) =>
    [member.id, source?.profiles.find((profile) => profile.id === member.profileId)])));
  const memberLabels = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const [id, profile] of members) {
      const label = profile?.name || id;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return new Map([...members].map(([id, profile]) => {
      const label = profile?.name || id;
      return [id, counts.get(label)! > 1 ? `${label} (${id})` : label];
    }));
  });
  const selected = $derived(editor.selected);
  const dirty = $derived(editor.dirty);
  const problemCount = $derived(editor.issues.length + editor.preflight.length);
  const availableHarnesses = $derived(workspace.catalog.harnesses
    .filter((item) => item.status === 'available' && (!remoteMode || remoteHarnessSupported(item.kind))));
  const defaultHarness = $derived(availableHarnesses[0]?.kind ?? (remoteMode ? undefined : 'codex'));
  const oneShotHarness = $derived(availableHarnesses.find((item) => harnessConfiguration(item.kind).oneShot)?.kind
    ?? (remoteMode ? undefined : 'codex'));
  /** Names of pinned steps (v6.4): the Start dialog offers to use their pinned data. */
  const pinnedSteps = $derived(editor.graph.nodes.filter((node) => node.pinnedOutput !== undefined).map((node) => node.profile.name || node.id));
  const systemItems = $derived<PickerItem[]>(editor.systems.map((item) => ({ value: item.id, label: item.name || $t('Untitled pipeline') })));
  const profileItems = $derived<PickerItem[]>(editor.profiles.map((item) => ({ value: item.id, label: item.name })));
  /** The start screen lists the first few saved pipelines; the Open menu has all of them. */
  const savedPipelines = $derived(editor.systems.slice(0, 6));

  $effect(() => onDirtyChange(dirty));
  $effect(() => {
    if (editor.lastRun) {
      onRun(editor.lastRun);
      editor.lastRun = undefined;
    }
  });

  onMount(() => {
    const listed = editor.refresh();
    void chatPipelines.loadLibrary(untrack(() => workspaceId));
    const draft = untrack(() => openDraft);
    void pluginRegistry.start();
    const initial = untrack(() => openCommandId);
    if (draft && untrack(() => draftSource) === 'template') {
      void openTemplateDraft(draft);
    } else if (draft) {
      editor.startFrom(draft);
      toasts.show({ title: $t('Opened from a run as a new draft'), description: $t('Saving creates a new pipeline; the saved one is not changed.') });
      setTimeout(() => api?.fitView(), 60);
    } else if (initial) editor.open(initial);
    else void reopenLast(listed);
    return () => {
      onDirtyChange(false);
      // Leaving the editor stops its script tests' process trees.
      editor.scriptTests.cancelAll();
    };
  });

  /**
   * Coming back from Runs or Automations reopens the pipeline this project had
   * open, unless it is gone or something else was started meanwhile.
   */
  async function reopenLast(listed: Promise<boolean>): Promise<void> {
    const ok = await listed;
    const id = readLastPipeline(workspaceId);
    restoring = false;
    // A list that could not be read says nothing about the pipeline: keep it remembered.
    if (!id || !ok) return;
    if (!editor.systems.some((item) => item.id === id)) {
      forgetLastPipeline(workspaceId);
      return;
    }
    if (editor.dirty || editor.busy || editor.graph.nodes.length > 0) return;
    editor.open(id);
  }

  async function openTemplateDraft(draft: AgentGraph): Promise<void> {
    editor.startFrom(await withDefaultModels(draft, defaultModel));
    toasts.show({ title: $t('Opened a template as a new pipeline'), description: $t('Save it to use it in chats and runs.') });
    setTimeout(() => api?.fitView(), 60);
  }

  /** The harness's default model, so new agents can run at once. */
  function defaultModel(harness: AgentProfile['harness']): Promise<Pick<AgentProfile, 'model' | 'modelProvider'> | undefined> {
    return editor.defaultModel(harness, workspace.catalog.harnesses.find((item) => item.kind === harness)?.version);
  }

  async function addAt(kind: 'agent' | 'router' | 'llm' | 'script', screen: { x: number; y: number } | undefined = undefined): Promise<void> {
    if (editor.readOnly) return;
    const harness = kind === 'llm' ? oneShotHarness : defaultHarness;
    if ((kind === 'agent' || kind === 'llm') && !harness) {
      editor.errors = ['No compatible read-only harness is available on this computer.'];
      return;
    }
    const point = screen && api ? api.toFlow(screen) : (api?.viewportCenter() ?? { x: 80, y: 80 });
    const id = editor.addNode(kind, { x: point.x - 124, y: point.y - 50 });
    if ((kind !== 'agent' && kind !== 'llm') || !harness) return;
    const current = editor.graph.nodes.find((node) => node.id === id)?.profile;
    if (!current) return;
    const moved = profileForHarness(current, harness);
    // A model call stays read-only, offline and without tools on every harness.
    const locked = remoteMode || kind === 'llm' ? { permissionMode: 'read-only' as const, networkAccess: undefined } : { networkAccess: moved.networkAccess };
    editor.updateProfile(id, { ...moved, serviceTier: moved.serviceTier, ...locked });
    // The model arrives with the catalog; edits made meanwhile (a name, another harness or model) stay.
    const model = await defaultModel(harness);
    const now = editor.graph.nodes.find((node) => node.id === id)?.profile;
    if (model && now && now.harness === harness && !now.model.trim()) editor.updateProfile(id, model);
  }

  /** Node types of active plugins for the Add menu (v6.5). */
  const pluginNodes = $derived(pluginNodeMenu(pluginRegistry.nodeTypes()));

  /** Saved pipelines of this project a sub-pipeline step can run (v6.7): never this one. */
  const subpipelineItems = $derived(editor.systems.filter((item) => item.id !== editor.graph.id));

  function addSubpipeline(commandId: string): void {
    if (editor.readOnly) return;
    const point = api?.viewportCenter() ?? { x: 80, y: 80 };
    editor.addSubpipelineNode(commandId, { x: point.x - 124, y: point.y - 50 });
  }

  function addPluginNode(index: number): void {
    const entry = pluginNodes[index];
    if (editor.readOnly || entry === undefined) return;
    const point = api?.viewportCenter() ?? { x: 80, y: 80 };
    editor.addPluginNode(entry.node, entry.resultFields, { x: point.x - 124, y: point.y - 50 });
  }

  async function addFromLibrary(profileId: string): Promise<void> {
    try {
      const stored = await orchestrationHost.orchestration_get_profile_v6({ workspaceId, id: profileId });
      if (!stored) return;
      const point = api?.viewportCenter() ?? { x: 80, y: 80 };
      editor.addFromProfile(stored.value, { x: point.x - 124, y: point.y - 50 });
    } catch {
      toasts.error($t('Could not add the saved agent'));
    }
  }

  // The start screen needs the default harness's models for its templates;
  // probing starts the native harness, so it begins before the first click.
  $effect(() => {
    const harness = defaultHarness;
    if (!harness) return;
    const version = workspace.catalog.harnesses.find((item) => item.kind === harness)?.version;
    if (harness === 'nano') void nanoAccount.catalogRevision;
    if (editor.graph.nodes.length === 0 && !restoring && !editor.safeMode && !editor.readOnly) {
      untrack(() => void editor.loadCatalog(harness, false, version));
    }
  });

  function withModel(graph: AgentGraph, model: Pick<AgentProfile, 'model' | 'modelProvider'>): AgentGraph {
    return {
      ...graph,
      nodes: graph.nodes.map((node) =>
        (node.kind === 'router' && node.router?.mode === 'program') || node.profile.model.trim() ? node : { ...node, profile: { ...node.profile, ...model } },
      ),
    };
  }

  async function useTemplate(id: TemplateId): Promise<void> {
    const harness = defaultHarness;
    if (!harness) return;
    const graph = buildTemplate(id, harness, (value) => $t(value));
    // The draft opens at once; the harness's own default model fills in when the harness names it
    // (the catalog shown may be a remembered copy in an older order).
    editor.startFrom(graph);
    setTimeout(() => api?.fitView(), 60);
    const model = await defaultModel(harness);
    if (model && editor.graph.id === graph.id) editor.fillIn(withModel(editor.graph, model));
  }

  async function useUserTemplate(template: PipelineTemplateV1): Promise<void> {
    try {
      await openTemplateDraft(graphFromTemplate(template, editor.systems));
    } catch (error) {
      toasts.error($t('This template could not be opened'), error instanceof Error ? error.message : undefined);
    }
  }

  async function exportFile(): Promise<void> {
    try {
      const text = await editor.exportText();
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${(editor.graph.name || 'pipeline').replace(/[^\p{L}\p{N}_-]+/gu, '-')}.piui.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      if (pinnedSteps.length) toasts.show({ title: $t('Pinned data is not exported'), description: $t('System files never include pinned data; the pins stay in Nano Desktop.') });
    } catch (error) {
      toasts.error($t('Could not export'), error instanceof Error ? $t(error.message) : undefined);
    }
  }

  async function importPicked(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) editor.importText(await file.text());
  }

  async function save(): Promise<void> {
    if (await editor.save()) toasts.success($t('Pipeline saved'));
    else if (editor.issues.length) toasts.error($t('Fix the problems before saving'), $t('{0} problems found', [editor.issues.length]));
  }

  async function run(): Promise<void> {
    // Pipelines that ask for inputs or hold pinned data start from the form; the rest start now.
    if (editor.graph.inputs?.length || pinnedSteps.length) {
      inputsOpen = true;
      return;
    }
    await startRun(undefined);
  }

  async function startRun(values: Record<string, RunInputValue> | undefined, usePinnedData: boolean = false): Promise<boolean> {
    const ok = await editor.save(true, values, usePinnedData);
    if (!ok && problemCount) toasts.error($t('The pipeline has problems'), $t('Open a highlighted node to see what to fix.'));
    else if (!ok && editor.errors.length) toasts.error($t('Could not start the run'), $t(editor.errors[0]!));
    return ok;
  }

  function focusNode(id: string): void {
    editor.selectedId = id;
    const node = editor.graph.nodes.find((item) => item.id === id);
    if (node) api?.center(node.x + 124, node.y + 60);
  }

  function keydown(event: KeyboardEvent): void {
    // The script editor lives in a shadow root: read the real target, not its host.
    const target = (event.composedPath()[0] ?? event.target) as HTMLElement;
    if (target.closest('input, textarea, [contenteditable="true"]')) return;
    if (matchesShortcut(event, 'Mod+Z')) {
      event.preventDefault();
      editor.undo();
    } else if (matchesShortcut(event, 'Mod+Shift+Z') || matchesShortcut(event, 'Mod+Y')) {
      event.preventDefault();
      editor.redo();
    } else if (matchesShortcut(event, 'Mod+S')) {
      event.preventDefault();
      if (!editor.readOnly && editor.graph.nodes.length > 0 && dirty) void save();
    } else if (
      event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !editor.readOnly &&
      (target === document.body || target.localName === 'main') && canvasElement?.matches(':hover')
    ) {
      // Tab opens Add right after a click on the empty canvas (focus is then on the page, not on a control).
      // With focus on a card or a button, or while editing is off (safe mode, busy), Tab moves focus as everywhere else.
      event.preventDefault();
      addMenuOpen = true;
    }
  }
</script>

<svelte:window onkeydown={keydown} />

<section class="editor" class:editor--remote={remoteMode} aria-label={$t('Pipeline editor')}>
  <header class="bar">
    <div class="identity">
      <input
        class="name"
        value={editor.graph.name}
        placeholder={$t('Untitled pipeline')}
        aria-label={$t('Pipeline name')}
        disabled={editor.readOnly}
        oninput={(event) => editor.rename(event.currentTarget.value)}
        onblur={() => editor.settle()}
      />
      {#if editor.busy}
        <Badge><Spinner size={10} /> {editor.operation === 'open' ? $t('Opening…') : editor.operation === 'check' ? $t('Checking…') : editor.operation === 'run' ? $t('Starting…') : $t('Saving…')}</Badge>
      {:else if dirty}
        <Badge tone="warning">{$t('Unsaved')}</Badge>
      {:else if editor.graph.nodes.length}
        <Badge tone="success">{$t('Saved')}</Badge>
      {/if}
    </div>

    <Picker items={systemItems} value={editor.graph.id} label={$t('Open pipeline')} searchPlaceholder={$t('Search pipelines')} emptyText={$t('No saved pipelines')} onSelect={(id) => editor.open(id)}>
      {#snippet trigger(props)}
        <button type="button" class="switcher" {...props}>
          <Workflow size={14} />
          <span>{$t('Open')}</span>
          <ChevronDown size={12} />
        </button>
      {/snippet}
    </Picker>

    <div class="spacer"></div>

    {#if !remoteMode}
    <Button size="sm" variant={assistantOpen ? 'secondary' : 'ghost'} aria-pressed={assistantOpen} onclick={() => setAssistant(!assistantOpen)}>
      {#snippet leading()}<Sparkles />{/snippet}
      {$t('Assistant')}
    </Button>
    {/if}

    {#if editor.checkedNotice && !editor.stale && !problemCount}
      <span class="ok"><CircleCheck size={14} /> {$t('Checked')}</span>
    {/if}
    {#if !remoteMode}<Button size="sm" variant="ghost" onclick={() => void editor.runCheck()} disabled={editor.readOnly || editor.graph.nodes.length === 0}>
      {#snippet leading()}{#if problemCount}<CircleAlert />{:else}<ShieldCheck />{/if}{/snippet}
      {problemCount ? $t('{0} problems', [problemCount]) : $t('Check')}
    </Button>{/if}
    {#if !remoteMode || dirty}<Button size="sm" onclick={() => void save()} disabled={editor.readOnly || editor.graph.nodes.length === 0 || !dirty} loading={editor.operation === 'save'}>
      {#snippet leading()}<Save />{/snippet}
      {$t('Save')}
    </Button>{/if}
    {#if !remoteMode || (hostSupports('orchestration_start_run_v6') && editor.remoteRunnable)}
    <Button size="sm" variant="primary" onclick={() => void run()} disabled={editor.safeMode || editor.busy || editor.graph.nodes.length === 0} loading={editor.operation === 'run'}>
      {#snippet leading()}<Play />{/snippet}
      {$t('Run')}
    </Button>
    {:else if editor.graph.nodes.length}
      <span class="remote-note">{$t('Start this pipeline on the computer.')}</span>
    {/if}
    <Menu
      align="end"
      items={[
        ...(remoteMode && !editor.readOnly && editor.graph.nodes.length ? [{ label: $t('Check'), icon: ShieldCheck, onSelect: () => void editor.runCheck() }] : []),
        { label: $t('New pipeline'), icon: FilePlus, onSelect: () => editor.newGraph() },
        ...(!remoteMode ? [{ label: $t('Import JSON…'), icon: Upload, disabled: safeMode, onSelect: () => filePicker?.click() },
        { label: $t('Export JSON'), icon: Download, disabled: editor.graph.nodes.length === 0, onSelect: () => void exportFile() },
        { label: $t('Save as template…'), icon: BookmarkPlus, disabled: safeMode || editor.graph.nodes.length === 0, onSelect: () => (saveTemplateOpen = true) }] : []),
      ]}
    >
      {#snippet trigger(props)}
        <button type="button" class="icon-trigger" aria-label={$t('More pipeline actions')} {...props}><Ellipsis size={16} /></button>
      {/snippet}
    </Menu>
    <input bind:this={filePicker} type="file" accept=".json,application/json" hidden onchange={(event) => void importPicked(event)} />
  </header>

  {#if source}
    <details class="assignments">
      <summary>{$t('Saved assignments · read-only')}</summary>
      <p>{$t('Edit the original assignments on the computer.')}</p>
      <ul>
        {#each source.pipeline.steps as step (step.id)}
          <li><strong>{step.name || step.id}</strong> · {memberLabels.get(step.assignedMemberId) ?? step.assignedMemberId}</li>
        {/each}
        {#each source.team.sendEdges as edge}
          <li>{$t('Messages')} · {memberLabels.get(edge.fromMemberId) ?? edge.fromMemberId} → {memberLabels.get(edge.toMemberId) ?? edge.toMemberId}</li>
        {/each}
        {#each source.team.observeEdges as edge}
          <li>{$t('Observe')} · {memberLabels.get(edge.fromMemberId) ?? edge.fromMemberId} → {memberLabels.get(edge.toMemberId) ?? edge.toMemberId}</li>
        {/each}
        {#each source.team.members as member (member.id)}
          {#each members.get(member.id)?.allowedSpawnProfileIds ?? [] as profileId}
            <li>{$t('Delegate')} · {memberLabels.get(member.id) ?? member.id} → {source.profiles.find((profile) => profile.id === profileId)?.name || profileId}</li>
          {/each}
        {/each}
      </ul>
    </details>
  {/if}
  {#if editor.errors.length}
    <div class="error" role="alert">
      {#each editor.errors as error (error)}<p>{$t(error)}</p>{/each}
    </div>
  {/if}

  <div class="workspace">
    <div class="editor__canvas" bind:this={canvasElement}>
      <FlowCanvas {editor} onready={(next) => (api = next)} onAddRequest={(point) => void addAt('agent', point)} />

      <div class="add">
        <Menu
          bind:open={addMenuOpen}
          align="start"
          items={[
            { type: 'label', label: $t('Add to canvas') },
            { label: $t('Agent'), icon: Bot, disabled: !defaultHarness, onSelect: () => void addAt('agent') },
            { label: $t('Router'), icon: Split, onSelect: () => void addAt('router') },
            { label: $t('Model call'), icon: MessageSquareText, disabled: !oneShotHarness, onSelect: () => void addAt('llm') },
            ...(!remoteMode ? [{ label: $t('Script'), icon: Code, onSelect: () => void addAt('script') }] : []),
            ...(pluginNodes.length
              ? [{ type: 'separator' as const }, { type: 'label' as const, label: $t('Plugin nodes') }, ...pluginNodes.map((entry, index) => ({ label: entry.label, icon: Blocks, onSelect: () => addPluginNode(index) }))]
              : []),
            ...(!remoteMode && subpipelineItems.length
              ? [
                  { type: 'separator' as const },
                  { type: 'label' as const, label: $t('Sub-pipelines') },
                  ...subpipelineItems.slice(0, 12).map((item) => ({ label: item.name || $t('Untitled pipeline'), icon: Workflow, onSelect: () => addSubpipeline(item.id) })),
                ]
              : []),
            ...(!remoteMode && profileItems.length
              ? [{ type: 'separator' as const }, { type: 'label' as const, label: $t('From library') }, ...profileItems.slice(0, 8).map((item) => ({ label: item.label, icon: Library, onSelect: () => void addFromLibrary(item.value) }))]
              : []),
          ]}
        >
          {#snippet trigger(props)}
            <Button size="sm" variant="secondary" disabled={editor.readOnly} {...props}>
              {#snippet leading()}<Plus />{/snippet}
              {$t('Add')}
            </Button>
          {/snippet}
        </Menu>
      </div>

      {#if editor.graph.nodes.length === 0 && !editor.busy && !restoring}
        <div class="start">
          <h2>{$t(remoteMode ? 'Pipelines' : 'Build a pipeline')}</h2>
          {#if remoteMode}
            {#if !savedPipelines.length}<p>{$t('Saved pipelines from this project appear here.')}</p>{/if}
            {#if !editor.readOnly && !defaultHarness}<p>{$t('No compatible read-only harness is available on this computer.')}</p>{/if}
            {#if !editor.readOnly}<Button size="sm" disabled={!defaultHarness} onclick={() => void addAt('agent')}>{#snippet leading()}<Plus />{/snippet}{$t('Add agent')}</Button>{/if}
          {:else}
          <button type="button" class="ask" onclick={() => setAssistant(true)} disabled={editor.readOnly}>
            <Sparkles size={15} />
            <strong>{$t('Describe it to the assistant')}</strong>
          </button>
          {/if}
          {#if savedPipelines.length}
            <h3 class="templates__title">{$t('Saved pipelines')}</h3>
            <div class="templates">
              {#each savedPipelines as item (item.id)}
                <button type="button" class="template" onclick={() => editor.open(item.id)} disabled={editor.busy}>
                  <strong>{item.name || $t('Untitled pipeline')}</strong>
                </button>
              {/each}
            </div>
            {#if !remoteMode}<h3 class="templates__title">{$t('Templates')}</h3>{/if}
          {/if}
          {#if !remoteMode}<div class="templates">
            {#each TEMPLATES as template (template.id)}
              <button type="button" class="template" onclick={() => void useTemplate(template.id)} disabled={editor.readOnly}>
                <strong>{$t(template.title)}</strong>
                <span>{$t(template.description)}</span>
              </button>
            {/each}
            <PluginTemplates disabled={editor.readOnly} onImport={(text) => editor.importText(text)} />
          </div>
          {/if}
          {#if !remoteMode && userTemplates.length}
            <h3 class="templates__title">{$t('Your templates')}</h3>
            <div class="templates">
              {#each userTemplates as template (template.id)}
                <button type="button" class="template" onclick={() => void useUserTemplate(template)} disabled={editor.readOnly}>
                  <strong>{template.name}</strong>
                  <span>{template.description ?? (template.scope.kind === 'global' ? $t('Every project') : projectName)}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      {#if problemCount && !selected}
        <div class="problems">
          <strong><CircleAlert size={14} /> {$t('{0} problems', [problemCount])}</strong>
          <ul>
            {#each editor.issues as issue, index (index)}
              <li><button type="button" onclick={() => issue.nodeIds[0] && focusNode(issue.nodeIds[0])}>{editor.describeIssue(issue.message, (value) => $t(value))}</button></li>
            {/each}
            {#each editor.preflight as issue, index (index)}
              <li><button type="button" onclick={() => focusNode(issue.nodeId)}>{editor.describeIssue(issue.message, (value) => $t(value))}</button></li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>

    {#if selected}
      {#key selected.id}
        <NodeInspector {editor} node={selected} onClose={() => (editor.selectedId = '')} onFocusNode={focusNode} />
      {/key}
    {:else if editor.selectedBlock === 'start'}
      <StartInspector {editor} onClose={() => (editor.selectedId = '')} />
    {:else if editor.selectedBlock === 'output'}
      <OutputInspector {editor} onClose={() => (editor.selectedId = '')} />
    {/if}
    {#if assistantOpen && assistantModule}
      {#await assistantModule then module}
        <div class="assistant-slot">
          <module.default {editor} {workspaceId} onClose={() => setAssistant(false)} />
        </div>
      {/await}
    {/if}
  </div>
  {#if remoteMode && !selected && !editor.selectedBlock && editor.graph.nodes.length}
    <section class="mobile-steps" aria-label={$t('Pipeline steps')}>
      <h3>{$t('Pipeline steps')}</h3>
      <ul>
        {#each editor.graph.nodes as node (node.id)}
          <li><button type="button" onclick={() => focusNode(node.id)}>
            <Workflow size={16} aria-hidden="true" />
            <span>{node.profile.name || $t('Untitled agent')}</span>
            <span class="step-open" aria-hidden="true">›</span>
          </button></li>
        {/each}
      </ul>
    </section>
  {/if}
</section>

<SaveTemplateDialog bind:open={saveTemplateOpen} graph={editor.graph} {workspaceId} {projectName} pipelines={editor.systems} onSaved={() => void chatPipelines.loadLibrary(workspaceId)} />

<RunInputsDialog
  bind:open={inputsOpen}
  pipelineName={editor.graph.name}
  inputs={editor.graph.inputs ?? []}
  pinned={pinnedSteps}
  busy={editor.operation === 'run'}
  onStart={(values, options) => startRun(values, options.usePinnedData)}
/>

<Dialog
  open={editor.pending !== undefined}
  title={$t('Save changes to this pipeline?')}
  size="sm"
  dismissible={false}
>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => void editor.resolvePending('keep')}>{$t('Keep editing')}</Button>
    <Button variant="danger" onclick={() => void editor.resolvePending('discard')}>{$t('Discard')}</Button>
    <Button variant="primary" onclick={() => void editor.resolvePending('save')}>{$t('Save')}</Button>
  {/snippet}
</Dialog>

<style>
  .mobile-steps { display: none; }
  .assignments { flex: 0 1 auto; max-height: 30%; overflow-y: auto; padding-inline: var(--piui-space-3); border-bottom: 1px solid var(--piui-border-subtle); }
  .assignments summary { cursor: pointer; padding-block: var(--piui-space-2); color: var(--piui-text); }
  .assignments p, .assignments ul { margin: 0 0 var(--piui-space-2); color: var(--piui-text-muted); }
  .assignments li { overflow-wrap: anywhere; }
  .remote-note { font-size: var(--piui-text-sm); color: var(--piui-text-muted); }
  @media (max-width: 760px) {
    .editor--remote .bar { height: auto; flex-wrap: wrap; padding-block: var(--piui-space-1); }
    .editor--remote .identity { flex: 1 1 100%; }
    .mobile-steps { display: block; flex: 0 1 auto; max-height: 28dvh; overflow: auto; border-top: 1px solid var(--piui-border); background: var(--piui-bg-raised); }
    .mobile-steps h3 { margin: 0; padding: var(--piui-space-2) var(--piui-space-4) 0; font-size: var(--piui-text-sm); color: var(--piui-text-muted); }
    .mobile-steps ul { list-style: none; margin: 0; padding: 0 var(--piui-space-2); }
    .mobile-steps button { display:flex; align-items:center; gap:var(--piui-space-2); width:100%; min-height:44px; padding-inline:var(--piui-space-2); background:transparent; color:var(--piui-text); text-align:left; overflow-wrap:anywhere; }
    .mobile-steps button:focus-visible, .mobile-steps button:hover { background:var(--piui-hover); }
    .step-open { margin-left:auto; font-size:var(--piui-text-xl); color:var(--piui-text-muted); }
    .editor--remote .spacer { flex: 1; }
    .editor--remote .add { top: 12px; }
    .editor--remote .workspace { position: relative; }
    .editor--remote .workspace > :global(aside) { position: absolute; right: 0; inset-block: 0; width: min(100%, 360px); max-width: 100%; z-index: 8; }
    .editor--remote .templates { grid-template-columns: minmax(0, 1fr); }
    .editor--remote .start { width: calc(100% - 24px); padding: var(--piui-space-4); }
  }
  .editor {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--piui-header-height);
    padding: 0 var(--piui-space-3);
    border-bottom: 1px solid var(--piui-border-subtle);
    flex: none;
  }
  .identity {
    display: flex;
    align-items: center;
    gap: var(--piui-space-2);
    min-width: 0;
  }
  .name {
    width: clamp(160px, 26vw, 360px);
    height: 30px;
    padding: 0 8px;
    border: 1px solid transparent;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text);
    font-size: var(--piui-text-lg);
    font-weight: var(--piui-weight-semibold);
  }
  .name:hover {
    border-color: var(--piui-border-subtle);
  }
  .name:focus-visible {
    border-color: var(--piui-focus);
    outline: none;
  }
  .switcher,
  .icon-trigger {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--piui-radius-sm);
    background: transparent;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
  }
  .switcher:hover,
  .icon-trigger:hover {
    background: var(--piui-hover);
    color: var(--piui-text);
  }
  .spacer {
    flex: 1;
  }
  .ok {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--piui-success);
    font-size: var(--piui-text-sm);
  }
  .error {
    padding: 6px var(--piui-space-4);
    border-bottom: 1px solid var(--piui-danger-border);
    background: var(--piui-danger-surface);
    color: var(--piui-danger-text);
    flex: none;
  }
  .error p {
    margin: 0;
  }
  .workspace {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .editor__canvas {
    position: relative;
    flex: 1;
    min-width: 0;
  }
  .assistant-slot {
    display: flex;
    flex: none;
    width: clamp(320px, 28vw, 420px);
    min-height: 0;
  }
  .assistant-slot > :global(*) {
    flex: 1;
  }
  .ask {
    display: flex;
    align-items: center;
    gap: var(--piui-space-3);
    width: 100%;
    margin: var(--piui-space-4) 0 var(--piui-space-3);
    padding: var(--piui-space-3) var(--piui-space-4);
    border: 1px solid color-mix(in srgb, var(--piui-accent) 45%, var(--piui-border));
    border-radius: var(--piui-radius-md);
    background: color-mix(in srgb, var(--piui-accent) 8%, var(--piui-surface-1));
    color: var(--piui-text);
    text-align: left;
  }
  .ask :global(svg) {
    color: var(--piui-accent);
  }
  .ask:hover:not(:disabled) {
    background: color-mix(in srgb, var(--piui-accent) 14%, var(--piui-surface-1));
  }
  .add {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 5;
  }
  .start {
    position: absolute;
    top: 50%;
    left: 50%;
    z-index: 4;
    width: min(720px, calc(100% - 48px));
    max-height: calc(100% - 24px);
    overflow-y: auto;
    padding: var(--piui-space-6);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-lg);
    background: color-mix(in srgb, var(--piui-bg-raised) 94%, transparent);
    box-shadow: var(--piui-shadow-2);
    text-align: center;
    transform: translate(-50%, -50%);
  }
  .start h2 {
    margin: 0;
    font-size: var(--piui-text-2xl);
    font-weight: var(--piui-weight-semibold);
  }
  .templates__title {
    margin: var(--piui-space-4) 0 var(--piui-space-2);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    font-weight: var(--piui-weight-semibold);
    letter-spacing: 0.04em;
    text-align: left;
    text-transform: uppercase;
  }
  .templates {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: var(--piui-space-2);
    text-align: left;
  }
  .template {
    display: grid;
    gap: 4px;
    padding: var(--piui-space-3);
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: var(--piui-surface-1);
    color: var(--piui-text);
    text-align: left;
  }
  .template:hover:not(:disabled) {
    border-color: var(--piui-accent);
  }
  .template span {
    color: var(--piui-text-muted);
    font-size: var(--piui-text-sm);
    line-height: 1.4;
  }
  .problems {
    position: absolute;
    top: 60px;
    left: 12px;
    z-index: 5;
    width: min(360px, calc(100% - 24px));
    max-height: 40%;
    padding: var(--piui-space-3);
    overflow-y: auto;
    border: 1px solid var(--piui-danger-border);
    border-radius: var(--piui-radius-md);
    background: var(--piui-bg-raised);
    box-shadow: var(--piui-shadow-2);
  }
  .problems strong {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--piui-danger);
  }
  .problems ul {
    display: grid;
    gap: 2px;
    margin: 6px 0 0;
    padding: 0;
    list-style: none;
  }
  .problems button {
    width: 100%;
    padding: 4px 6px;
    border: 0;
    border-radius: var(--piui-radius-xs);
    background: transparent;
    color: var(--piui-text);
    font-size: var(--piui-text-sm);
    text-align: left;
  }
  .problems button:hover {
    background: var(--piui-hover);
  }
</style>
