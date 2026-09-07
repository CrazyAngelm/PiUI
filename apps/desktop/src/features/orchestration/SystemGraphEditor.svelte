<script lang="ts">
  import { performRunAction } from './runActions';
  import { onMount } from 'svelte';
  import PanelResize from '../../components/PanelResize.svelte';
  import { modalFocus } from '../workspace/workspaceUx';
  import { harnessModels } from '../../host-api/harnessModels';
  import type { HarnessCatalogModel as WorkspaceModel } from '../../../../../contracts/harness-models-v14';
  import type { HarnessModelsResult } from '../../../../../contracts/harness-models-v14';
  import ResourcePicker from './ResourcePicker.svelte';
  import { harnessConfigurations, permissionLabels } from '../../harness-adapters';
  import { t } from '../locale/language';
  import { orchestrationHost, orchestrationError, type OrchestrationClient, type DefinitionSummary, type AgentProfile, type SaveDefinitionRequest, type StoredDefinition } from '../../host-api/orchestrationClient';
  import { emptyGraph, newGraphNode, compileGraph, graphErrors, patternEdges, type AgentGraph, type GraphNode, type ConnectionKind } from './agentGraph';
  export let modelsFor: (harness: AgentProfile['harness']) => import('../../../../../contracts/harness-models-v14').HarnessCatalogModel[] = () => [];
  export let workspaceId: string;
  export let safeMode = false;
  export let onDirtyChange: (dirty: boolean) => void = () => {};
  export let onRun: () => void = () => {};
  export let client: OrchestrationClient = orchestrationHost;
  let graph = emptyGraph();
  let baseline = JSON.stringify(graph);
  let commands: readonly DefinitionSummary[] = [];
  let revisions = new Map<string, number>();
  let selectedId = '';
  let busy = false;
  let errors: string[] = [];
  let from = '';
  let to = '';
  let kind: ConnectionKind = 'result';
  let zoom = 1;
  let inspectorWidth = 320;
  let taskExpanded = false;
  let filePicker: HTMLInputElement;
  let downloadUrl: string | undefined;
  let fileNotice = '';
  let pendingRunId: string | undefined;
  let mounted = false;
  let catalogHarness: AgentProfile['harness'] | undefined;
  let modelCatalogs: Partial<Record<AgentProfile['harness'], WorkspaceModel[]>> = {};
  let resourceCatalogs: Partial<Record<AgentProfile['harness'], HarnessModelsResult['resources']>> = {};
  let modelsLoading = false;
  let modelsError = '';
  let modelRequest = 0;
  async function loadModels(harness: AgentProfile['harness']): Promise<void> {
    catalogHarness = harness;
    const request = ++modelRequest;
    modelsLoading = true; modelsError = '';
    try {
      const catalog = await harnessModels({ workspaceId, harness });
      if (mounted && request === modelRequest) {
        modelCatalogs = { ...modelCatalogs, [harness]: catalog.models };
        resourceCatalogs = { ...resourceCatalogs, [harness]: catalog.resources };
      }
    } catch (error) { if (mounted && request === modelRequest) modelsError = error instanceof Error ? error.message : 'Could not load models.'; }
    finally { if (mounted && request === modelRequest) modelsLoading = false; }
  }
  $: if (mounted && selected && !safeMode && selected.profile.harness !== catalogHarness) void loadModels(selected.profile.harness);
  $: nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  let drag: { id: string; pointer: number; startX: number; startY: number; x: number; y: number } | undefined;
  $: availableModels = selected ? modelCatalogs[selected.profile.harness] ?? modelsFor(selected.profile.harness) : [];
  $: nativeModel = selected ? availableModels.find(model => model.id === selected.profile.model && model.provider === selected.profile.modelProvider) : undefined;
  $: configuration = selected ? harnessConfigurations[selected.profile.harness] : undefined;
  $: selected = graph.nodes.find(node => node.id === selectedId);
  $: dirty = JSON.stringify(graph) !== baseline;
  $: onDirtyChange(dirty);
  $: width = Math.max(1000, ...graph.nodes.map(node => node.x + 300));
  $: height = Math.max(560, ...graph.nodes.map(node => node.y + 220));
  onMount(() => { mounted = true; void refresh(); return () => { mounted = false; onDirtyChange(false); if (downloadUrl) URL.revokeObjectURL(downloadUrl); }; });
  async function importFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0]; input.value = '';
    if (!file || safeMode || busy) return;
    if (dirty) { errors = ['Save changes before opening another system.']; return; }
    busy = true; errors = [];
    try {
      const { parseSystemFile, systemFileToGraph } = await import('./systemFile');
      const next = systemFileToGraph(parseSystemFile(await file.text()));
      graph = next; revisions = new Map(); selectedId = next.nodes[0]?.id ?? ''; pendingRunId = undefined; fileNotice = 'Imported as a new system. Save to keep it.';
    } catch (error) { errors = [error instanceof Error ? error.message : 'Could not import system.']; }
    finally { busy = false; }
  }
  async function exportFile(): Promise<void> {
    if (busy) return;
    errors = [];
    try {
      const { serializeSystemFile } = await import('./systemFile');
      const text = serializeSystemFile(graph);
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      downloadUrl = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = downloadUrl; link.download = 'system.piui.json';
      link.click();
    } catch (error) { errors = [error instanceof Error ? error.message : 'Could not export system.']; }
  }
  async function refresh(): Promise<void> { try { commands = (await client.orchestration_catalog_v4({ workspaceId })).launchCommands; } catch (error) { errors = [orchestrationError(error).message]; } }
  function updateNode(id: string, change: Partial<GraphNode>): void { graph = { ...graph, nodes: graph.nodes.map(node => node.id === id ? { ...node, ...change } : node) }; }
  function updateProfile(change: Partial<AgentProfile>): void { if (selected) updateNode(selected.id, { profile: { ...selected.profile, ...change } }); }
  function add(): void { const node = newGraphNode(graph.nodes.length); graph = { ...graph, nodes: [...graph.nodes, node] }; selectedId = node.id; }
  function remove(): void { graph = { ...graph, nodes: graph.nodes.filter(node => node.id !== selectedId), edges: graph.edges.filter(edge => edge.from !== selectedId && edge.to !== selectedId) }; selectedId = ''; }
  function connect(): void { if (!from || !to || (from === to && kind !== 'spawn')) return; if (graph.edges.some(edge => edge.from === from && edge.to === to && edge.kind === kind)) return; graph = { ...graph, edges: [...graph.edges, { from, to, kind }] }; }
  function arrange(): void { graph = { ...graph, nodes: graph.nodes.map((node, index) => ({ ...node, x: 60 + index * 280, y: 100 })) }; }
  function pointerDown(event: PointerEvent, node: GraphNode): void {
    selectedId = node.id;
    if (safeMode || busy || event.button !== 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag = { id: node.id, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, x: node.x, y: node.y };
  }
  function pointerMove(event: PointerEvent): void { if (drag?.pointer === event.pointerId) updateNode(drag.id, { x: Math.max(0, drag.x + (event.clientX - drag.startX) / zoom), y: Math.max(0, drag.y + (event.clientY - drag.startY) / zoom) }); }
  function keyMove(event: KeyboardEvent, node: GraphNode): void {
    if (safeMode || busy || !event.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); const distance = event.shiftKey ? 40 : 10;
    updateNode(node.id, { x: Math.max(0, node.x + (event.key === 'ArrowRight' ? distance : event.key === 'ArrowLeft' ? -distance : 0)), y: Math.max(0, node.y + (event.key === 'ArrowDown' ? distance : event.key === 'ArrowUp' ? -distance : 0)) });
  }
  function requestNew(): void { if (dirty) { errors = ['Save changes before opening another system.']; return; } graph = emptyGraph(); baseline = JSON.stringify(graph); revisions = new Map(); selectedId = ''; }
  async function open(id: string): Promise<void> {
    if (!id || busy) return;
    if (dirty) { errors = ['Save changes before opening another system.']; return; }
    busy = true; errors = [];
    try {
      const command = await client.orchestration_get_launch_command_v4({ workspaceId, id }); if (!command) throw new Error('Missing command');
      const [team, pipeline, catalog] = await Promise.all([client.orchestration_get_team_v4({ workspaceId, id: command.value.teamId }), client.orchestration_get_pipeline_v4({ workspaceId, id: command.value.pipelineId }), client.orchestration_catalog_v4({ workspaceId })]);
      if (!team || !pipeline) throw new Error('Missing graph definition');
      const storedProfiles = await Promise.all(catalog.profiles.map(profile => client.orchestration_get_profile_v4({ workspaceId, id: profile.id })));
      const profiles = new Map(storedProfiles.filter((profile): profile is StoredDefinition<AgentProfile> => profile !== null).map(profile => [profile.value.id, profile]));
      const nodes = pipeline.value.steps.map((step, index) => { const member = team.value.members.find(item => item.id === step.assignedMemberId); const profile = member && profiles.get(member.profileId); if (!profile) throw new Error('Missing agent profile'); return { id: step.id, profile: profile.value, task: step.instructions, input: step.inputInstructions, x: 60 + index * 280, y: 100 }; });
      // A member may own several steps in older definitions; preserve the original editors for those graphs.
      if (new Set(nodes.map(node => node.profile.id)).size !== nodes.length || team.value.members.some(member => !pipeline.value.steps.some(step => step.id === member.id && step.assignedMemberId === member.id))) throw new Error('This definition uses reusable members. Open it in Library to preserve its assignments.');
      const next: AgentGraph = { id, name: command.value.name, teamId: team.value.id, pipelineId: pipeline.value.id, orchestratorId: team.value.orchestratorMemberId, spawnedAgentsJoinTeam: team.value.spawnedAgentsJoinTeam, nodes, edges: [
        ...pipeline.value.steps.flatMap(step => step.dependencyStepIds.map(dependency => ({ from: dependency, to: step.id, kind: 'result' as const }))),
        ...team.value.sendEdges.map(edge => ({ from: edge.fromMemberId, to: edge.toMemberId, kind: 'send' as const })),
        ...team.value.observeEdges.map(edge => ({ from: edge.fromMemberId, to: edge.toMemberId, kind: 'observe' as const })),
        ...nodes.flatMap(node => node.profile.allowedSpawnProfileIds.map(profileId => { const target = nodes.find(candidate => candidate.profile.id === profileId); if (!target) throw new Error('This definition delegates to an external profile. Open it in Library.'); return { from: node.id, to: target.id, kind: 'spawn' as const }; })),
      ] };
      try { const positions: unknown = JSON.parse(localStorage.getItem(`piui.graph.${workspaceId}.${id}`) ?? 'null'); if (Array.isArray(positions)) for (const position of positions) if (position && typeof position.id === 'string' && Number.isFinite(position.x) && Number.isFinite(position.y)) { const node = next.nodes.find(item => item.id === position.id); if (node) { node.x = Math.max(0, position.x); node.y = Math.max(0, position.y); } } } catch { /* Positions are rebuildable UI metadata. */ }
      graph = next; baseline = JSON.stringify(graph); selectedId = nodes[0]?.id ?? '';
      revisions = new Map([[id, command.revision], [team.value.id, team.revision], [pipeline.value.id, pipeline.revision], ...nodes.map(node => [node.profile.id, profiles.get(node.profile.id)!.revision] as [string, number])]);
    } catch (error) { errors = [error instanceof Error && !('code' in error) ? error.message : orchestrationError(error).message]; }
    finally { busy = false; }
  }
  async function save(run = false): Promise<void> {
    if (safeMode || busy) return;
    errors = graphErrors(graph); if (errors.length) return;
    busy = true;
    try {
      const definition = compileGraph(graph);
      const request = <T extends { id: string }>(value: T): SaveDefinitionRequest<T> => ({ workspaceId, value, ...(revisions.has(value.id) ? { expectedRevision: revisions.get(value.id)! } : {}) });
      await client.orchestration_save_graph_v4({ workspaceId, profiles: definition.profiles.map(value => request(value)), team: request(definition.team), pipeline: request(definition.pipeline), command: request(definition.command) });
      revisions = new Map([...definition.profiles, definition.team, definition.pipeline, definition.command].map(value => [value.id, (revisions.get(value.id) ?? -1) + 1]));
      baseline = JSON.stringify(graph); fileNotice = '';
      try { localStorage.setItem(`piui.graph.${workspaceId}.${graph.id}`, JSON.stringify(graph.nodes.map(({ id, x, y }) => ({ id, x, y })))); } catch { /* Definition already persisted by the host. */ }
      await refresh();
      if (run) {
        pendingRunId ??= crypto.randomUUID();
        const outcome = await performRunAction(client, { type: 'start', request: { workspaceId, runId: pendingRunId, teamId: graph.teamId, pipelineId: graph.pipelineId, launchCommandId: graph.id } }, safeMode);
        if (outcome.type === 'unconfirmed') { errors = [outcome.error.message]; }
        else { pendingRunId = undefined; onRun(); }
      }
    } catch (error) { errors = [orchestrationError(error).message]; }
    finally { busy = false; }
  }
</script>

<section class="system-editor" inert={taskExpanded} aria-label={$t('Agent system')}>
  <header class="toolbar">
    <input class="system-name" aria-label={$t('Name')} placeholder={$t('Agent system')} bind:value={graph.name} disabled={safeMode || busy} />
    <select aria-label={$t('Open system')} value={revisions.has(graph.id) ? graph.id : ''} onchange={(event) => void open(event.currentTarget.value)} disabled={busy}><option value="">{$t('Open system')}</option>{#each commands as command}<option value={command.id}>{command.name}</option>{/each}</select>
    <button onclick={requestNew} disabled={busy || safeMode}>{$t('New system')}</button>
    <details class="file-menu"><summary>{$t('File')}</summary><div>
      <button onclick={() => filePicker.click()} disabled={safeMode || busy}>{$t('Import JSON')}</button>
      <button onclick={() => void exportFile()} disabled={busy || !graph.nodes.length}>{$t('Export JSON')}</button>
    </div></details>
    <input class="file-input" bind:this={filePicker} type="file" accept=".json,application/json" aria-label={$t('Import JSON')} onchange={(event) => void importFile(event)} tabindex="-1" />
    <span class="save-state" aria-live="polite">{$t(busy ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved')}</span>
    <button onclick={() => void save()} disabled={busy || safeMode}>{$t('Save')}</button>
    <button class="primary" onclick={() => void save(true)} disabled={busy || safeMode || !graph.nodes.length}>{$t('Run')}</button>
  </header>
  {#if fileNotice}<p class="notice" role="status">{$t(fileNotice)}</p>{/if}
  {#if safeMode}<p class="notice">{$t('Safe mode: viewing only.')}</p>{/if}
  {#if errors.length}<div class="errors" role="alert">{#each errors as error}<p>{$t(error)}</p>{/each}</div>{/if}
  <div class="graph-layout" class:has-selection={selected !== undefined} style:--graph-inspector-width={`${inspectorWidth}px`}>
    <div class="canvas-column">
      <div class="canvas-tools">
        <button onclick={add} disabled={safeMode || busy}>＋ {$t('Add agent')}</button>
        <select aria-label={$t('Pattern')} value="" onchange={(event) => { graph = { ...graph, edges: patternEdges(graph.nodes, event.currentTarget.value) }; event.currentTarget.value = ''; }} disabled={safeMode || busy || !graph.nodes.length}><option value="" disabled hidden>{$t('Pattern')}</option><option value="sequential">{$t('Sequential')}</option><option value="parallel">{$t('Parallel')}</option><option value="supervisor">{$t('Supervisor')}</option><option value="peer">{$t('Peer team')}</option></select>
        <button onclick={arrange} disabled={safeMode || busy}>{$t('Arrange')}</button>
        <span class="spacer"></span><button aria-label={$t('Zoom out')} onclick={() => zoom = zoom / 1.2}>−</button><button aria-label={$t('Reset view')} onclick={() => zoom = 1}>{Math.round(zoom * 100)}%</button><button aria-label={$t('Zoom in')} onclick={() => zoom = zoom * 1.2}>＋</button>
      </div>
      <div class="canvas" role="region" aria-label={$t('Agent system')}>
        {#if !graph.nodes.length}<div class="empty"><h2>{$t('Agent system')}</h2><p>{$t('Add agents, then connect their results or allow communication.')}</p><button class="primary" onclick={add} disabled={safeMode}>＋ {$t('Add agent')}</button></div>{/if}
        <div style:width={`${width * zoom}px`} style:height={`${height * zoom}px`}>
          <div class="world" style:width={`${width}px`} style:height={`${height}px`} style:transform={`scale(${zoom})`}>
            <svg width={width} height={height} aria-hidden="true"><defs><marker id="graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" /></marker></defs>
              {#each graph.edges as edge}{@const source = nodeById.get(edge.from)}{@const target = nodeById.get(edge.to)}{#if source && target}<path class:secondary-edge={edge.kind !== 'result'} class:spawn-edge={edge.kind === 'spawn'} class:observe-edge={edge.kind === 'observe'} d={`M ${source.x + 200} ${source.y + 48} C ${source.x + 245} ${source.y + 48}, ${target.x - 50} ${target.y + 48}, ${target.x} ${target.y + 48}`} marker-end="url(#graph-arrow)" />{/if}{/each}
            </svg>
            {#each graph.nodes as node (node.id)}<button class="node" class:selected={node.id === selectedId} style:left={`${node.x}px`} style:top={`${node.y}px`} aria-pressed={node.id === selectedId} onpointerdown={(event) => pointerDown(event, node)} onpointermove={pointerMove} onpointerup={() => drag = undefined} onpointercancel={() => drag = undefined} onclick={() => selectedId = node.id} onkeydown={(event) => keyMove(event, node)}><span class="port port-in" aria-hidden="true"></span><span class="port port-out" aria-hidden="true"></span><span class="harness">{harnessConfigurations[node.profile.harness].name}</span><strong>{node.profile.name}</strong><span>{node.profile.model || $t('Model')}</span><small>{node.profile.reasoning ?? $t('Model default')}{node.profile.serviceTier === 'fast' ? ' · Fast' : ''}</small></button>{/each}
          </div>
        </div>
      </div>
      <details class="connections" open={graph.nodes.length > 1}><summary>{$t('Connections')} <span>{graph.edges.length}</span></summary>
        <div class="connection-form"><select aria-label={$t('From')} bind:value={from}><option value="">{$t('From')}</option>{#each graph.nodes as node}<option value={node.id}>{node.profile.name}</option>{/each}</select><select aria-label={$t('To')} bind:value={to}><option value="">{$t('To')}</option>{#each graph.nodes as node}<option value={node.id}>{node.profile.name}</option>{/each}</select><select aria-label={$t('Connections')} bind:value={kind}><option value="result">{$t('Result dependency')}</option><option value="send">{$t('Messaging')}</option><option value="observe">{$t('Observation')}</option><option value="spawn">{$t('Delegation')}</option></select><button onclick={connect} disabled={safeMode || busy || !from || !to}>{$t('Connect')}</button></div>
        <ul>{#each graph.edges as edge, index}<li><span>{nodeById.get(edge.from)?.profile.name} → {nodeById.get(edge.to)?.profile.name}</span><small>{$t(edge.kind === 'result' ? 'Result dependency' : edge.kind === 'send' ? 'Messaging' : edge.kind === 'observe' ? 'Observation' : 'Delegation')}</small><button aria-label={`${$t('Remove')} ${index + 1}`} disabled={safeMode || busy} onclick={() => graph = { ...graph, edges: graph.edges.filter((_, i) => i !== index) }}>×</button></li>{/each}</ul>
      </details>
    </div>
    {#if selected}<aside aria-label={$t('Agent settings')}>
      <PanelResize label={$t('Resize agent settings')} storageKey="piui.graph.inspector.width" initial={320} minimum={260} edge="left" onresize={(width) => inspectorWidth = width} />
      <div class="inspector-heading"><h2>{selected.profile.name}</h2><button class="close-inspector" aria-label={$t('Close')} onclick={(event) => { event.currentTarget.closest('.graph-layout')?.querySelector<HTMLButtonElement>('.node.selected')?.focus(); selectedId = ''; }}>×</button></div>
        <label>{$t('Name')}<input value={selected.profile.name} oninput={(event) => updateProfile({ name: event.currentTarget.value })} disabled={safeMode || busy} /></label>
        <label>Harness<select value={selected.profile.harness} onchange={(event) => { const harness = event.currentTarget.value as AgentProfile['harness']; updateProfile({ harness, model: '', modelProvider: undefined, permissionMode: harnessConfigurations[harness].defaultPermission, serviceTier: harnessConfigurations[harness].speed ? 'standard' : undefined, baseInstructions: undefined, reasoning: undefined }); }} disabled={safeMode || busy}><option value="codex">Codex</option><option value="prime-agent">Prime Agent</option><option value="pi">Pi</option></select></label>
        <label>{$t('Model')}<select aria-label={$t('Model')} value={JSON.stringify([selected.profile.modelProvider, selected.profile.model])} onchange={(event) => { const model = availableModels.find(entry => JSON.stringify([entry.provider, entry.id]) === event.currentTarget.value); if (model) updateProfile({ model: model.id, modelProvider: model.provider, reasoning: undefined, serviceTier: model.supportsFast && selected?.profile.serviceTier === 'fast' ? 'fast' : undefined }); }} disabled={safeMode || busy || modelsLoading}>
          {#if !nativeModel}<option disabled={!selected.profile.model} hidden={!selected.profile.model} value={JSON.stringify([selected.profile.modelProvider, selected.profile.model])}>{selected.profile.model || $t(modelsLoading ? 'Loading models…' : 'Select model')}</option>{/if}
          {#each availableModels as model}<option value={JSON.stringify([model.provider, model.id])}>{model.name}{model.provider ? ` · ${model.provider}` : ''}</option>{/each}
        </select></label>
        {#if modelsError}<small class="model-error" role="alert">{modelsError}</small><button type="button" onclick={() => loadModels(selected.profile.harness)} disabled={modelsLoading}>{$t('Try again')}</button>{/if}
        <label>{$t('Reasoning')}<select aria-label={$t('Reasoning')} value={selected.profile.reasoning ?? ''} onchange={(event) => updateProfile({ reasoning: event.currentTarget.value || undefined })} disabled={safeMode || busy || !nativeModel?.thinkingLevels?.length}>
          <option value="">{$t('Model default')}</option>
          {#if selected.profile.reasoning && !nativeModel?.thinkingLevels?.includes(selected.profile.reasoning)}<option value={selected.profile.reasoning}>{selected.profile.reasoning}</option>{/if}
          {#each nativeModel?.thinkingLevels ?? [] as level}<option value={level}>{$t(level)}</option>{/each}
        </select></label>
        {#if configuration?.speed}<label>{$t('Speed')}<select value={selected.profile.serviceTier ?? 'standard'} onchange={(event) => updateProfile({ serviceTier: event.currentTarget.value as 'standard' | 'fast' })} disabled={safeMode || busy}><option value="standard">{$t('Standard')}</option><option value="fast" disabled={!nativeModel?.supportsFast}>Fast</option></select></label>{#if selected.profile.serviceTier === 'fast'}<small>{$t('Fast may use additional credits.')}</small>{/if}{/if}
        <div class="task-heading"><span>{$t('Task')}</span><button type="button" onclick={() => taskExpanded = true}>{$t('Expand editor')}</button></div>
        <textarea class="task-input" aria-label={$t('Task')} rows="9" placeholder={$t('Describe the goal, expected result and constraints…')} value={selected.task} oninput={(event) => updateNode(selectedId, { task: event.currentTarget.value })} disabled={safeMode || busy}></textarea>
        <label>{$t('Input')}<textarea aria-label={$t('Input')} rows="5" placeholder={$t('What should upstream agents provide?')} value={selected.input ?? ''} oninput={(event) => updateNode(selectedId, { input: event.currentTarget.value })} disabled={safeMode || busy}></textarea></label>
        <section class="setting-group" aria-label={$t('Instructions')}>
          <label>{$t('When to call')}<textarea aria-label={$t('When to call')} rows="3" value={selected.profile.whenToCall ?? ''} placeholder={$t('When is this agent useful?')} oninput={(event) => updateProfile({ whenToCall: event.currentTarget.value })} disabled={safeMode || busy}></textarea></label>
          <label>{$t('Expected result')}<textarea aria-label={$t('Expected result')} rows="4" value={selected.profile.expectedResult ?? ''} placeholder={$t('What should this agent return?')} oninput={(event) => updateProfile({ expectedResult: event.currentTarget.value })} disabled={safeMode || busy}></textarea></label>
          <label>{$t('Additional instructions')}<textarea rows="5" value={selected.profile.instructions} oninput={(event) => updateProfile({ instructions: event.currentTarget.value })} disabled={safeMode || busy}></textarea></label>
          {#if configuration?.basePrompt}
            <label class="check-row"><input type="checkbox" checked={selected.profile.baseInstructions !== undefined} onchange={(event) => updateProfile({ baseInstructions: event.currentTarget.checked ? '' : undefined })} disabled={safeMode || busy} />{$t('Replace base prompt')}</label>
            {#if selected.profile.baseInstructions !== undefined}<label>{$t('Base prompt')}<textarea rows="5" value={selected.profile.baseInstructions} oninput={(event) => updateProfile({ baseInstructions: event.currentTarget.value })} disabled={safeMode || busy}></textarea></label><small>{$t('Replaces the built-in coding prompt. Leave empty for no base text. Tool descriptions, project instructions and native permission context still apply.')}</small>{/if}
          {/if}
        </section>
        <label>{$t('File access')}<select value={selected.profile.permissionMode} onchange={(event) => updateProfile({ permissionMode: event.currentTarget.value as AgentProfile['permissionMode'] })} disabled={safeMode || busy}>{#each configuration?.permissionModes ?? [] as mode}<option value={mode}>{$t(permissionLabels[mode])}</option>{/each}</select></label>
        {#if !configuration?.filesystemSandbox}<small>{$t('The adapter does not enforce a filesystem sandbox.')}</small>{/if}
        <section class="setting-group" aria-label={$t('Subagents')}>
          <h3>{$t('Subagents')}</h3>
          <small>{$t('Choose which agents this profile may create. This controls workspace delegation, not native processes or OS access.')}</small>
          {#each graph.nodes as candidate (candidate.id)}<label class="check-row"><input type="checkbox" checked={graph.edges.some(edge => edge.from === selectedId && edge.to === candidate.id && edge.kind === 'spawn')} disabled={safeMode || busy} onchange={(event) => { graph = { ...graph, edges: event.currentTarget.checked ? [...graph.edges, { from: selectedId, to: candidate.id, kind: 'spawn' }] : graph.edges.filter(edge => !(edge.from === selectedId && edge.to === candidate.id && edge.kind === 'spawn')) }; }} />{candidate.profile.name}</label>{/each}
        </section>
        <ResourcePicker profile={selected.profile} items={resourceCatalogs[selected.profile.harness]?.items ?? []} loading={modelsLoading} disabled={safeMode || busy} onchange={updateProfile} />
        {#each resourceCatalogs[selected.profile.harness]?.warnings ?? [] as warning}<small role="status">{$t(warning)}</small>{/each}
<button class="danger" onclick={remove} disabled={safeMode || busy}>{$t('Remove agent')}</button>
      </aside>{/if}
  </div>
</section>

{#if taskExpanded && selected}
  <div class="task-backdrop">
    <div class="task-editor" role="dialog" aria-modal="true" aria-labelledby="task-editor-title" tabindex="-1" use:modalFocus={() => taskExpanded = false}>
      <header><div><small>{selected.profile.name}</small><h2 id="task-editor-title">{$t('Task')}</h2></div><button type="button" onclick={() => taskExpanded = false}>{$t('Done')}</button></header>
      <textarea aria-label={$t('Task')} value={selected.task} oninput={(event) => updateNode(selectedId, { task: event.currentTarget.value })} disabled={safeMode || busy} placeholder={$t('Describe the goal, expected result and constraints…')}></textarea>
    </div>
  </div>
{/if}

<style>
  .setting-group { display:grid; gap:10px; border-top:1px solid var(--piui-border-subtle); padding-top:14px; }
  .setting-group h3 { margin:0; font-size:12px; font-weight:600; }
  aside .check-row { display:flex; align-items:center; gap:8px; color:var(--piui-text); }
  .check-row input { min-height:0; padding:0; width:14px; height:14px; accent-color:var(--piui-action); }
  .task-heading { display:flex; align-items:center; justify-content:space-between; font-size:12px; color:var(--piui-text-muted); }
  .task-heading button { border:0; background:transparent; font-size:11px; color:var(--piui-accent); }
  .task-input { min-height:180px; flex-shrink:0; line-height:1.6; }
  .task-backdrop { position:fixed; inset:0; z-index:60; padding:5vh 6vw; display:grid; place-items:center; background:#0008; }
  .task-editor { width:min(960px,100%); height:100%; box-sizing:border-box; display:flex; flex-direction:column; border:1px solid var(--piui-border-strong); border-radius:var(--piui-radius-lg); background:var(--piui-bg-raised); overflow:hidden; box-shadow:0 20px 70px #0006; }
  .task-editor header { display:flex; justify-content:space-between; align-items:center; padding:16px 20px; border-bottom:1px solid var(--piui-border-subtle); }
  .task-editor h2 { margin:4px 0 0; font-size:16px; } .task-editor small { color:var(--piui-text-muted); }
  .task-editor textarea { flex:1; width:100%; box-sizing:border-box; border:0; border-radius:0; padding:20px; resize:none; line-height:1.7; background:var(--piui-bg); }
  .file-input { display:none; }
  .file-menu { position:relative; } .file-menu summary { cursor:pointer; padding:5px 9px; }
  .file-menu > div { position:absolute; right:0; top:100%; z-index:10; min-width:140px; padding:4px; border:1px solid var(--piui-border); border-radius:6px; background:var(--piui-bg-raised); }
  .file-menu button { display:block; width:100%; border:0; text-align:left; }
  .system-editor { color:var(--piui-text); height:100%; min-height:0; display:flex; flex-direction:column; }
  .toolbar,.canvas-tools { display:flex; gap:6px; align-items:center; padding:8px 14px; border-bottom:1px solid var(--piui-border-subtle); flex-wrap:wrap; }
  input,select,textarea,button { font:inherit; color:var(--piui-text); border:1px solid var(--piui-border); background:var(--piui-bg-raised); border-radius:6px; padding:5px 9px; min-width:0; min-height:30px; }
  button { cursor:pointer; transition:background-color 120ms ease,border-color 120ms ease; } button:hover:not(:disabled) { background:var(--piui-surface-2); } button:disabled { opacity:.5; cursor:default; }
  input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible,.canvas:focus-visible,summary:focus-visible { outline:2px solid var(--piui-focus); outline-offset:2px; }
  .system-name { font-size:13px; font-weight:600; border-color:transparent; background:transparent; flex:1; min-width:120px; } .system-name:focus { background:var(--piui-bg-raised); border-color:var(--piui-border); }
  .toolbar > select { max-width:180px; } .save-state { color:var(--piui-text-faint); font-size:11px; } .primary { background:var(--piui-action); color:var(--piui-action-ink); border-color:transparent; font-weight:600; } .primary:hover:not(:disabled) { background:var(--piui-action); filter:brightness(1.1); }
  .graph-layout { flex:1; display:grid; grid-template-columns:minmax(0,1fr); min-height:0; } .graph-layout.has-selection { grid-template-columns:minmax(0,1fr) var(--graph-inspector-width); }
  .canvas-column { min-width:0; min-height:0; display:flex; flex-direction:column; } .canvas-tools { padding:6px 12px; font-size:12px; } .canvas-tools button,.canvas-tools select { border-color:transparent; background:transparent; } .canvas-tools button:hover,.canvas-tools select:hover { background:var(--piui-surface-1); } .spacer { flex:1; }
  .canvas { position:relative; overflow:auto; flex:1; min-height:0; background-color:var(--piui-bg); background-image:radial-gradient(var(--piui-border-subtle) .7px,transparent .7px); background-size:20px 20px; } .world { position:relative; transform-origin:0 0; } svg { position:absolute; pointer-events:none; } svg > path { fill:none; stroke:var(--piui-text-faint); stroke-width:1.5; } svg > path.secondary-edge { stroke:var(--piui-text-muted); stroke-dasharray:5 5; } svg > path.spawn-edge { stroke:var(--piui-accent); } svg > path.observe-edge { stroke-dasharray:2 6; }
  .node { position:absolute; width:200px; min-height:96px; display:grid; gap:3px; text-align:left; padding:11px 14px; touch-action:none; user-select:none; background:var(--piui-bg-raised); border-radius:8px; box-shadow:0 3px 12px #0001; }
  .node.selected { border-color:var(--piui-action); background:color-mix(in srgb,var(--piui-bg-raised) 90%,var(--piui-accent-soft)); box-shadow:0 0 0 1px var(--piui-accent-soft); }
  .node strong { font-size:13px; font-weight:600; overflow-wrap:anywhere; } .node span,.node small { color:var(--piui-text-muted); overflow-wrap:anywhere; font-size:11px; } .node .harness { font-size:10px; letter-spacing:.03em; }
  .node .port { position:absolute; top:43px; width:8px; height:8px; border:1px solid var(--piui-border-strong); border-radius:50%; background:var(--piui-bg); } .port-in { left:-5px; } .port-out { right:-5px; } .node.selected .port { border-color:var(--piui-accent); }
  aside { position:relative; min-width:0; min-height:0; border-left:1px solid var(--piui-border-subtle); padding:14px; display:flex; flex-direction:column; gap:11px; overflow:auto; background:var(--piui-bg-raised); }
  .inspector-heading { display:flex; align-items:center; justify-content:space-between; padding-bottom:10px; border-bottom:1px solid var(--piui-border-subtle); } aside h2 { font-size:13px; margin:0; font-weight:600; } .close-inspector { border:0; padding:0; width:28px; min-height:28px; font-size:18px; color:var(--piui-text-muted); }
  aside label { display:grid; gap:5px; font-size:12px; color:var(--piui-text-muted); } aside label input,aside label select,textarea { background:var(--piui-bg); } aside small { color:var(--piui-text-faint); font-size:11px; line-height:1.45; } textarea { min-height:78px; resize:vertical; } .danger { color:var(--piui-danger-text); background:transparent; border-color:transparent; margin-top:auto; text-align:left; }
  .connections { border-top:1px solid var(--piui-border-subtle); padding:8px 12px; font-size:12px; background:var(--piui-bg-raised); } summary { cursor:pointer; } summary span { color:var(--piui-text-faint); margin-left:8px; } .connection-form { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; } .connection-form select { flex:1; } ul { list-style:none; margin:6px 0 0; padding:0; max-height:180px; overflow:auto; } li { display:flex; gap:10px; align-items:center; padding:2px 0; } li span { flex:1; } li small { color:var(--piui-text-faint); } li button { border:0; background:transparent; }
  .empty { position:absolute; top:80px; left:10%; right:10%; z-index:1; text-align:center; } .empty h2 { font-size:20px; font-weight:500; } .empty p { font-size:13px; color:var(--piui-text-muted); margin-bottom:20px; } .notice,.errors { padding:8px 14px; font-size:12px; } .errors { color:var(--piui-danger-text); background:var(--piui-danger-surface); } .errors p { margin:4px 0; }
  @media(max-width:900px) { .save-state { display:none; } .toolbar > select { max-width:140px; } }
  @media(max-width:700px) { .graph-layout.has-selection { grid-template-columns:1fr; grid-template-rows:minmax(160px,1fr) minmax(0,1fr); } aside { border-left:0; border-top:1px solid var(--piui-border-subtle); } }
</style>
