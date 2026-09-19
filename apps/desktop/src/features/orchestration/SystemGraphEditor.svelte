<script lang="ts">
  import { connectAgents, visibleConnections, type ConnectionDirection } from './graphConnections';
  import { preflightGraph, type PreflightIssue } from './graphPreflight';
  import { performRunAction } from './runActions';
  import { onMount } from 'svelte';
  import PanelResize from '../../components/PanelResize.svelte';
  import { modalFocus } from '../workspace/workspaceUx';
  import { harnessModels } from '../../host-api/harnessModels';
  import type { HarnessCatalogModel as WorkspaceModel } from '../../../../../contracts/harness-models-v18';
  import type { HarnessModelsResult } from '../../../../../contracts/harness-models-v18';
  import FlowSettings from './FlowSettings.svelte';
  import ResultFields from './ResultFields.svelte';
  import ResourcePicker from './ResourcePicker.svelte';
  import { harnessConfigurations, permissionLabels } from '../../harness-adapters';
  import { t } from '../locale/language';
  import { orchestrationHost, orchestrationError, type OrchestrationClient, type DefinitionSummary, type AgentProfile, type SaveDefinitionRequest, type StoredDefinition } from '../../host-api/orchestrationClient';
  import { emptyGraph, newGraphNode, compileGraph, graphErrors, patternEdges, type AgentGraph, type GraphNode, type ConnectionKind } from './agentGraph';
  import { arrangeResultDependencies, fitGraphZoom, graphBounds } from './graphLayout';
  export let modelsFor: (harness: AgentProfile['harness']) => import('../../../../../contracts/harness-models-v18').HarnessCatalogModel[] = () => [];
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
  let preflightIssues: PreflightIssue[] = [];
  let preflightNotice = '';
  let errors: string[] = [];
  let from = '';
  let to = '';
  let kind: ConnectionKind = 'result';
  let direction: ConnectionDirection = 'forward';
  let world: HTMLDivElement;
  let connectionStart: { id: string; side: 'in' | 'out' } | undefined;
  let connectionPoint: { x: number; y: number } | undefined;
  let connectionPointer: number | undefined;
  let connectionError = '';
  let selectedEdgeKey = '';
  let canvas: HTMLDivElement;
  let inspectorCollapsed = false;
  $: renderedEdges = visibleConnections(graph.edges);
  $: if (kind === 'result' && direction === 'both') direction = 'forward';
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
  async function loadModels(harness: AgentProfile['harness'], refresh = false): Promise<void> {
    catalogHarness = harness;
    const request = ++modelRequest;
    modelsLoading = true; modelsError = '';
    try {
      const catalog = await harnessModels({ workspaceId, harness }, refresh);
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
  async function refresh(): Promise<void> { try { commands = (await client.orchestration_catalog_v6({ workspaceId })).launchCommands; } catch (error) { errors = [orchestrationError(error).message]; } }
  function updateNode(id: string, change: Partial<GraphNode>): void { graph = { ...graph, nodes: graph.nodes.map(node => node.id === id ? { ...node, ...change } : node) }; }
  function updateProfile(change: Partial<AgentProfile>): void { if (selected) updateNode(selected.id, { profile: { ...selected.profile, ...change } }); }
  function add(): void { const node = newGraphNode(graph.nodes.length); graph = { ...graph, nodes: [...graph.nodes, node] }; selectedId = node.id; }
  function remove(): void { graph = { ...graph, nodes: graph.nodes.filter(node => node.id !== selectedId), edges: graph.edges.filter(edge => edge.from !== selectedId && edge.to !== selectedId) }; selectedId = ''; }
  function connect(): void {
    if (safeMode || busy) return;
    const result = connectAgents(graph, from, to, kind, direction);
    connectionError = result.error ?? '';
    if (!result.error) graph = { ...graph, edges: result.edges };
  }
  function cancelConnection(): void { connectionStart = undefined; connectionPoint = undefined; connectionPointer = undefined; }
  function finishConnection(id: string, side: 'in' | 'out'): void {
    if (!connectionStart || safeMode || busy) return;
    if (connectionStart.side === side) { connectionError = 'Connect an output to an input.'; cancelConnection(); return; }
    from = connectionStart.side === 'out' ? connectionStart.id : id;
    to = connectionStart.side === 'in' ? connectionStart.id : id;
    connect(); cancelConnection();
  }
  function portClick(event: MouseEvent, id: string, side: 'in' | 'out'): void {
    if (safeMode || busy) return;
    // Pointer gestures are handled on release; keyboard activation uses click.
    if (event.detail !== 0) return;
    if (connectionStart) finishConnection(id, side);
    else { connectionStart = { id, side }; connectionError = ''; }
  }
  function portDown(event: PointerEvent, id: string, side: 'in' | 'out'): void {
    if (safeMode || busy || event.button !== 0) return;
    event.stopPropagation();
    if (!connectionStart) { connectionStart = { id, side }; connectionError = ''; }
    connectionPointer = event.pointerId;
  }
  function connectionMove(event: PointerEvent): void {
    if (!connectionStart) return;
    const bounds = world.getBoundingClientRect();
    connectionPoint = { x: (event.clientX - bounds.left) / zoom, y: (event.clientY - bounds.top) / zoom };
  }
  function connectionUp(event: PointerEvent): void {
    if (!connectionStart || connectionPointer !== event.pointerId) return;
    connectionPointer = undefined;
    const port = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-port]');
    if (!port) { cancelConnection(); return; }
    const id = port.dataset.nodeId, side = port.dataset.port;
    if (!id || (side !== 'in' && side !== 'out')) { cancelConnection(); return; }
    if (id !== connectionStart.id || side !== connectionStart.side) finishConnection(id, side);
  }
  function edgePath(source: GraphNode, target: GraphNode): string {
    if (source.id === target.id) return `M ${source.x + 200} ${source.y + 48} C ${source.x + 260} ${source.y - 60}, ${source.x - 60} ${source.y - 60}, ${source.x} ${source.y + 48}`;
    const sign = source.x <= target.x ? 1 : -1;
    const x1 = source.x + (sign === 1 ? 200 : 0), x2 = target.x + (sign === 1 ? 0 : 200);
    return `M ${x1} ${source.y + 48} C ${x1 + sign * 50} ${source.y + 48}, ${x2 - sign * 50} ${target.y + 48}, ${x2} ${target.y + 48}`;
  }
  function edgeKey(edge: { from: string; to: string }): string { return `${edge.from}:${edge.to}`; }
  function connectionLabel(connection: ConnectionKind): string {
    return connection === 'result' ? 'Result dependency' : connection === 'send' ? 'Messaging' : connection === 'observe' ? 'Observation' : 'Delegation';
  }
  function arrange(): void {
    const result = arrangeResultDependencies(graph.nodes, graph.edges);
    if (result.cycle) { connectionError = 'Arrange requires an acyclic result graph.'; return; }
    graph = { ...graph, nodes: result.nodes };
    connectionError = '';
    selectedEdgeKey = '';
  }
  function fit(): void {
    if (!graph.nodes.length || !canvas) { zoom = 1; return; }
    const bounds = graphBounds(graph.nodes);
    zoom = fitGraphZoom(graph.nodes, canvas.clientWidth, canvas.clientHeight);
    requestAnimationFrame(() => {
      const centerX = ((bounds.left + bounds.right) / 2) * zoom;
      const centerY = ((bounds.top + bounds.bottom) / 2) * zoom;
      canvas.scrollTo({ left: Math.max(0, centerX - canvas.clientWidth / 2), top: Math.max(0, centerY - canvas.clientHeight / 2), behavior: 'smooth' });
    });
  }
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
      const command = await client.orchestration_get_launch_command_v6({ workspaceId, id }); if (!command) throw new Error('Missing command');
      const [team, pipeline, catalog] = await Promise.all([client.orchestration_get_team_v6({ workspaceId, id: command.value.teamId }), client.orchestration_get_pipeline_v6({ workspaceId, id: command.value.pipelineId }), client.orchestration_catalog_v6({ workspaceId })]);
      if (!team || !pipeline) throw new Error('Missing graph definition');
      const storedProfiles = await Promise.all(catalog.profiles.map(profile => client.orchestration_get_profile_v6({ workspaceId, id: profile.id })));
      const profiles = new Map(storedProfiles.filter((profile): profile is StoredDefinition<AgentProfile> => profile !== null).map(profile => [profile.value.id, profile]));
      const nodes = pipeline.value.steps.map((step, index) => { const member = team.value.members.find(item => item.id === step.assignedMemberId); const profile = member && profiles.get(member.profileId); if (!profile) throw new Error('Missing agent profile'); return { id: step.id, profile: profile.value, task: step.instructions, inputBindings: step.inputBindings ? [...step.inputBindings] : undefined, condition: step.condition, review: step.review, requireApproval: step.requireApproval, resultFields: step.resultFields ? [...step.resultFields] : undefined, executionMode: step.executionMode, input: step.inputInstructions, x: 60 + index * 280, y: 100 }; });
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
  async function checkSystem(): Promise<boolean> {
    preflightNotice = ''; preflightIssues = [];
    const issues = await preflightGraph(graph, harness => harnessModels({ workspaceId, harness }, true));
    preflightIssues = issues;
    if (!issues.length) preflightNotice = 'Native settings verified. Launch permissions are checked again by the host.';
    return issues.length === 0;
  }
  async function checkOnly(): Promise<void> {
    if (busy || safeMode) return;
    busy = true; try { await checkSystem(); } finally { busy = false; }
  }
  async function save(run = false): Promise<void> {
    if (safeMode || busy) return;
    errors = graphErrors(graph); if (errors.length) return;
    busy = true;
    try {
      if (run && !await checkSystem()) return;
      const definition = compileGraph(graph);
      const request = <T extends { id: string }>(value: T): SaveDefinitionRequest<T> => ({ workspaceId, value, ...(revisions.has(value.id) ? { expectedRevision: revisions.get(value.id)! } : {}) });
      await client.orchestration_save_graph_v6({ workspaceId, profiles: definition.profiles.map(value => request(value)), team: request(definition.team), pipeline: request(definition.pipeline), command: request(definition.command) });
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

<svelte:window onpointermove={connectionMove} onpointerup={connectionUp} onpointercancel={cancelConnection} onkeydown={(event) => { if (event.key === 'Escape') cancelConnection(); }} />

<section class="system-editor" inert={taskExpanded} aria-label={$t('Agent system')}>
  <header class="toolbar">
    <div class="document-identity">
      <span class:dirty-dot={dirty} class="document-dot" aria-hidden="true"></span>
      <div class="document-title">
        <input class="system-name" aria-label={$t('Name')} placeholder={$t('Agent system')} bind:value={graph.name} disabled={safeMode || busy} />
        <span class="save-state" aria-live="polite">{$t(busy ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved')}</span>
      </div>
    </div>
    <div class="document-actions">
      <select aria-label={$t('Open system')} value={revisions.has(graph.id) ? graph.id : ''} onchange={(event) => void open(event.currentTarget.value)} disabled={busy}><option value="">{$t('Open system')}</option>{#each commands as command}<option value={command.id}>{command.name}</option>{/each}</select>
      <button class="toolbar-secondary" onclick={requestNew} disabled={busy || safeMode}>{$t('New system')}</button>
      <details class="file-menu"><summary>{$t('File')}</summary><div>
        <button onclick={() => filePicker.click()} disabled={safeMode || busy}>{$t('Import JSON')}</button>
        <button onclick={() => void exportFile()} disabled={busy || !graph.nodes.length}>{$t('Export JSON')}</button>
      </div></details>
      <input class="file-input" bind:this={filePicker} type="file" accept=".json,application/json" aria-label={$t('Import JSON')} onchange={(event) => void importFile(event)} tabindex="-1" />
      <span class="action-divider" aria-hidden="true"></span>
      <button class="toolbar-secondary" onclick={() => void checkOnly()} disabled={busy || safeMode || !graph.nodes.length}>{$t('Check system')}</button>
      <button class="toolbar-secondary" onclick={() => void save()} disabled={busy || safeMode}>{$t('Save')}</button>
      <button class="primary run-action" onclick={() => void save(true)} disabled={busy || safeMode || !graph.nodes.length}>{$t('Run')} <span aria-hidden="true">↗</span></button>
    </div>
  </header>
  {#if preflightNotice}<p class="notice" role="status">{$t(preflightNotice)}</p>{/if}
  {#if preflightIssues.length}<div class="errors" role="alert">{#each preflightIssues as issue}<button onclick={() => { selectedId = issue.nodeId; inspectorCollapsed = false; }}>{graph.nodes.find(node => node.id === issue.nodeId)?.profile.name}: {$t(issue.message)}</button>{/each}</div>{/if}
  {#if fileNotice}<p class="notice" role="status">{$t(fileNotice)}</p>{/if}
  {#if safeMode}<p class="notice">{$t('Safe mode: viewing only.')}</p>{/if}
  {#if errors.length}<div class="errors" role="alert">{#each errors as error}<p>{$t(error)}</p>{/each}</div>{/if}
  <div class="graph-layout" class:has-selection={selected !== undefined && !inspectorCollapsed} class:inspector-collapsed={inspectorCollapsed} style:--graph-inspector-width={`${inspectorWidth}px`}>
    <div class="canvas-column">
      <div class="canvas-tools">
        <button class="tool-primary" onclick={add} disabled={safeMode || busy}><span class="tool-icon" aria-hidden="true">＋</span> {$t('Add agent')}</button>
        <select aria-label={$t('Pattern')} value="" onchange={(event) => { graph = { ...graph, edges: patternEdges(graph.nodes, event.currentTarget.value) }; event.currentTarget.value = ''; }} disabled={safeMode || busy || !graph.nodes.length}><option value="" disabled hidden>{$t('Pattern')}</option><option value="sequential">{$t('Sequential')}</option><option value="parallel">{$t('Parallel')}</option><option value="supervisor">{$t('Supervisor')}</option><option value="peer">{$t('Peer team')}</option></select>
        <select aria-label={$t('Connection type')} bind:value={kind} disabled={safeMode || busy}><option value="result">{$t('Result dependency')}</option><option value="send">{$t('Messaging')}</option><option value="observe">{$t('Observation')}</option><option value="spawn">{$t('Delegation')}</option></select>
        <select aria-label={$t('Direction')} bind:value={direction} disabled={safeMode || busy}><option value="forward">→ {$t('One way')}</option><option value="reverse">← {$t('Reverse')}</option><option value="both" disabled={kind === 'result'}>↔ {$t('Both ways')}</option></select>
        <button onclick={arrange} disabled={safeMode || busy || graph.nodes.length < 2}>{$t('Arrange')}</button>
        <button onclick={fit} disabled={safeMode || busy || !graph.nodes.length}>{$t('Fit graph')}</button>
        <span class="spacer"></span>
        <div class="edge-legend" aria-label={$t('Connection legend')}>
          <span><i class="legend-line result-line"></i>{$t('Result dependency')}</span>
          <span><i class="legend-line message-line"></i>{$t('Messaging')}</span>
          <span><i class="legend-line observe-line"></i>{$t('Observation')}</span>
        </div>
        <span class="canvas-summary">{$t('Graph summary', [graph.nodes.length, graph.edges.length])}</span>
        <div class="zoom-controls"><button aria-label={$t('Zoom out')} onclick={() => zoom = Math.max(.45, zoom / 1.2)}>−</button><button aria-label={$t('Reset view')} onclick={() => zoom = 1}>{Math.round(zoom * 100)}%</button><button aria-label={$t('Zoom in')} onclick={() => zoom = Math.min(1.6, zoom * 1.2)}>＋</button></div>
        {#if selected && inspectorCollapsed}<button class="inspector-reopen" onclick={() => inspectorCollapsed = false}>{$t('Show inspector')}</button>{/if}
      </div>
      {#if connectionStart}<div class="connection-status" role="status">{$t('Choose another port or press Escape.')}<button onclick={cancelConnection}>{$t('Cancel')}</button></div>{/if}
      {#if connectionError}<p class="errors" role="alert">{$t(connectionError)}</p>{/if}
      <div bind:this={canvas} class="canvas" role="region" aria-label={$t('Agent system')}>
        {#if !graph.nodes.length}<div class="empty"><h2>{$t('Agent system')}</h2><p>{$t('Add agents, then connect their results or allow communication.')}</p><button class="primary" onclick={add} disabled={safeMode}>＋ {$t('Add agent')}</button></div>{/if}
        <div style:width={`${width * zoom}px`} style:height={`${height * zoom}px`}>
          <div bind:this={world} class="world" style:width={`${width}px`} style:height={`${height}px`} style:transform={`scale(${zoom})`}>
            <svg width={width} height={height} aria-hidden="true"><defs><marker id="graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" /></marker></defs>
              {#each renderedEdges as edge}{@const source = nodeById.get(edge.from)}{@const target = nodeById.get(edge.to)}{@const key = edgeKey(edge)}{#if source && target}<path class:selected-edge={selectedEdgeKey === key} class:related-edge={selected !== undefined && (edge.from === selected.id || edge.to === selected.id)} class:muted-edge={selected !== undefined && edge.from !== selected.id && edge.to !== selected.id} class:secondary-edge={edge.kind !== 'result'} class:spawn-edge={edge.kind === 'spawn'} class:observe-edge={edge.kind === 'observe'} d={edgePath(source, target)} marker-start={edge.both ? 'url(#graph-arrow)' : undefined} marker-end="url(#graph-arrow)"><title>{edge.connections.map(connection => `${nodeById.get(connection.from)?.profile.name} → ${nodeById.get(connection.to)?.profile.name}: ${$t(connectionLabel(connection.kind))}`).join('\n')}</title></path>{/if}{/each}
              {#if connectionStart && connectionPoint}{@const source = nodeById.get(connectionStart.id)}{#if source}<path class="connection-preview" d={`M ${source.x + (connectionStart.side === 'out' ? 200 : 0)} ${source.y + 48} L ${connectionPoint.x} ${connectionPoint.y}`} marker-end="url(#graph-arrow)" />{/if}{/if}
            </svg>
            {#each graph.nodes as node (node.id)}<div class="node-shell" style:left={`${node.x}px`} style:top={`${node.y}px`}><button class="node" class:selected={node.id === selectedId} class:node-related={selected !== undefined && node.id !== selected.id && graph.edges.some((edge) => (edge.from === selected.id && edge.to === node.id) || (edge.to === selected.id && edge.from === node.id))} aria-pressed={node.id === selectedId} onpointerdown={(event) => pointerDown(event, node)} onpointermove={pointerMove} onpointerup={() => drag = undefined} onpointercancel={() => drag = undefined} onclick={() => { selectedId = node.id; inspectorCollapsed = false; }} onkeydown={(event) => keyMove(event, node)}>
              <span class="node-topline"><span class="harness">{harnessConfigurations[node.profile.harness].name}</span><span class="node-kind">{$t('Agent')}</span></span>
              <strong>{node.profile.name}</strong>
              <span class="node-model">{node.profile.model || $t('Model')}</span>
              <span class="node-task">{node.task.trim() || $t('No task yet')}</span>
              <small>{node.profile.reasoning ?? $t('Model default')}{node.profile.serviceTier === 'fast' ? $t(' · Fast') : ''}</small>
            </button>{#each ['in', 'out'] as side}<button class="port" class:port-in={side === 'in'} class:port-out={side === 'out'} class:connecting={connectionStart?.id === node.id && connectionStart.side === side} data-port={side} data-node-id={node.id} aria-label={`${$t(side === 'in' ? 'Input connection' : 'Output connection')}: ${node.profile.name}`} disabled={safeMode || busy} onpointerdown={(event) => portDown(event, node.id, side as 'in' | 'out')} onclick={(event) => portClick(event, node.id, side as 'in' | 'out')} onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!event.repeat) event.currentTarget.click(); } }}></button>{/each}</div>{/each}
          </div>
        </div>
      </div>
      <details class="connections" open={graph.nodes.length > 1}><summary>{$t('Connections')} <span>{graph.edges.length}</span></summary>
        <div class="connection-form"><select aria-label={$t('From')} bind:value={from}><option value="">{$t('From')}</option>{#each graph.nodes as node}<option value={node.id}>{node.profile.name}</option>{/each}</select><select aria-label={$t('To')} bind:value={to}><option value="">{$t('To')}</option>{#each graph.nodes as node}<option value={node.id}>{node.profile.name}</option>{/each}</select><select aria-label={$t('Connections')} bind:value={kind}><option value="result">{$t('Result dependency')}</option><option value="send">{$t('Messaging')}</option><option value="observe">{$t('Observation')}</option><option value="spawn">{$t('Delegation')}</option></select><button onclick={connect} disabled={safeMode || busy || !from || !to}>{$t('Connect')}</button></div>
        <ul>{#each graph.edges as edge, index}<li class:selected-connection={selectedEdgeKey === edgeKey(edge)}><button class="connection-link" onclick={() => { selectedEdgeKey = edgeKey(edge); selectedId = edge.to; inspectorCollapsed = false; }}><span>{nodeById.get(edge.from)?.profile.name} <b aria-hidden="true">→</b> {nodeById.get(edge.to)?.profile.name}</span><small>{$t(connectionLabel(edge.kind))}</small></button><button class="connection-remove" aria-label={`${$t('Remove')} ${index + 1}`} disabled={safeMode || busy} onclick={() => { selectedEdgeKey = ''; graph = { ...graph, edges: graph.edges.filter((_, i) => i !== index) }; }}>×</button></li>{/each}</ul>
      </details>
    </div>
    {#if selected && !inspectorCollapsed}<aside aria-label={$t('Agent settings')}>
      <PanelResize label={$t('Resize agent settings')} storageKey="piui.graph.inspector.width" initial={320} minimum={260} edge="left" onresize={(width) => inspectorWidth = width} />
      <div class="inspector-heading"><div><span class="eyebrow">{$t('Selected agent')}</span><h2>{selected.profile.name}</h2></div><button class="close-inspector" aria-label={$t('Hide inspector')} onclick={(event) => { event.currentTarget.closest('.graph-layout')?.querySelector<HTMLButtonElement>('.node.selected')?.focus(); inspectorCollapsed = true; }}>×</button></div>
        <label>{$t('Name')}<input value={selected.profile.name} oninput={(event) => updateProfile({ name: event.currentTarget.value })} disabled={safeMode || busy} /></label>
        <label>{$t("Harness")}<select value={selected.profile.harness} onchange={(event) => { const harness = event.currentTarget.value as AgentProfile['harness']; updateProfile({ harness, model: '', modelProvider: undefined, permissionMode: harnessConfigurations[harness].defaultPermission, networkAccess: undefined, serviceTier: harnessConfigurations[harness].speed ? 'standard' : undefined, baseInstructions: undefined, reasoning: undefined }); }} disabled={safeMode || busy}><option value="codex">Codex</option><option value="prime-agent">Prime Agent</option><option value="pi">Pi</option><option value="hermes">Hermes</option></select></label>
        <label>{$t('Model')}<select aria-label={$t('Model')} value={JSON.stringify([selected.profile.modelProvider, selected.profile.model])} onchange={(event) => { const model = availableModels.find(entry => JSON.stringify([entry.provider, entry.id]) === event.currentTarget.value); if (model) updateProfile({ model: model.id, modelProvider: model.provider, reasoning: undefined, serviceTier: model.supportsFast && selected?.profile.serviceTier === 'fast' ? 'fast' : undefined }); }} disabled={safeMode || busy || modelsLoading}>
          {#if !nativeModel}<option disabled={!selected.profile.model} hidden={!selected.profile.model} value={JSON.stringify([selected.profile.modelProvider, selected.profile.model])}>{selected.profile.model || $t(modelsLoading ? 'Loading models…' : 'Select model')}</option>{/if}
          {#each availableModels as model}<option value={JSON.stringify([model.provider, model.id])}>{model.name}{model.provider ? ` · ${model.provider}` : ''}</option>{/each}
        </select></label>
        {#if modelsError}<small class="model-error" role="alert">{$t(modelsError)}</small><button type="button" onclick={() => loadModels(selected.profile.harness, true)} disabled={modelsLoading}>{$t('Try again')}</button>{:else}<button type="button" onclick={() => loadModels(selected.profile.harness, true)} disabled={modelsLoading || safeMode || busy}>{$t(modelsLoading ? 'Loading models…' : 'Refresh models')}</button>{/if}
        <label>{$t('Reasoning')}<select aria-label={$t('Reasoning')} value={selected.profile.reasoning ?? ''} onchange={(event) => updateProfile({ reasoning: event.currentTarget.value || undefined })} disabled={safeMode || busy || !nativeModel?.thinkingLevels?.length}>
          <option value="">{$t('Model default')}</option>
          {#if selected.profile.reasoning && !nativeModel?.thinkingLevels?.includes(selected.profile.reasoning)}<option value={selected.profile.reasoning}>{selected.profile.reasoning}</option>{/if}
          {#each nativeModel?.thinkingLevels ?? [] as level}<option value={level}>{$t(level)}</option>{/each}
        </select></label>
        {#if configuration?.speed}<label>{$t('Speed')}<select value={selected.profile.serviceTier ?? 'standard'} onchange={(event) => updateProfile({ serviceTier: event.currentTarget.value as 'standard' | 'fast' })} disabled={safeMode || busy}><option value="standard">{$t('Standard')}</option><option value="fast" disabled={!nativeModel?.supportsFast}>{$t("Fast")}</option></select></label>{#if selected.profile.serviceTier === 'fast'}<small>{$t('Fast may use additional credits.')}</small>{/if}{/if}
        <div class="task-heading"><span>{$t('Task')}</span><button type="button" onclick={() => taskExpanded = true}>{$t('Expand editor')}</button></div>
        <textarea class="task-input" aria-label={$t('Task')} rows="9" placeholder={$t('Describe the goal, expected result and constraints…')} value={selected.task} oninput={(event) => updateNode(selectedId, { task: event.currentTarget.value })} disabled={safeMode || busy}></textarea>
        <label>{$t('Input')}<textarea aria-label={$t('Input')} rows="5" placeholder={$t('What should upstream agents provide?')} value={selected.input ?? ''} oninput={(event) => updateNode(selectedId, { input: event.currentTarget.value })} disabled={safeMode || busy}></textarea></label>
        <section class="setting-group" aria-label={$t('Instructions')}>
          <label>{$t('When to call')}<textarea aria-label={$t('When to call')} rows="3" value={selected.profile.whenToCall ?? ''} placeholder={$t('When is this agent useful?')} oninput={(event) => updateProfile({ whenToCall: event.currentTarget.value })} disabled={safeMode || busy}></textarea></label>
          <label>{$t('Expected result')}<textarea aria-label={$t('Expected result')} rows="4" value={selected.profile.expectedResult ?? ''} placeholder={$t('What should this agent return?')} oninput={(event) => updateProfile({ expectedResult: event.currentTarget.value })} disabled={safeMode || busy}></textarea></label>
          <label>{$t('Additional instructions')}<textarea rows="5" value={selected.profile.instructions} oninput={(event) => updateProfile({ instructions: event.currentTarget.value })} disabled={safeMode || busy}></textarea></label>
          {#if configuration?.basePrompt}
            <label class="check-row"><input type="checkbox" checked={selected.profile.baseInstructions === undefined} onchange={(event) => updateProfile({ baseInstructions: event.currentTarget.checked ? undefined : '' })} disabled={safeMode || busy} />{$t('Use base prompt')}</label>
          {/if}
        </section>
        <FlowSettings node={selected} nodes={graph.nodes} edges={graph.edges} disabled={safeMode || busy} onchange={(change) => updateNode(selectedId, change)} />
        <ResultFields fields={selected.resultFields ?? []} disabled={safeMode || busy} onchange={(resultFields) => updateNode(selectedId, { resultFields })} />
        <label>{$t('Execution mode')}<select value={selected.executionMode ?? 'scheduled'} onchange={(event) => updateNode(selectedId, { executionMode: event.currentTarget.value as 'scheduled' | 'callable' })} disabled={safeMode || busy}><option value="scheduled">{$t('Run by dependencies')}</option><option value="callable">{$t('Only when called')}</option></select></label>
        <label>{$t('File access')}<select value={selected.profile.permissionMode} onchange={(event) => { const permissionMode = event.currentTarget.value as AgentProfile['permissionMode']; updateProfile({ permissionMode, ...(!['read-only', 'workspace-write'].includes(permissionMode) ? { networkAccess: undefined } : {}) }); }} disabled={safeMode || busy}>{#each configuration?.permissionModes ?? [] as mode}<option value={mode}>{$t(permissionLabels[mode])}</option>{/each}</select></label>
        {#if !configuration?.filesystemSandbox}<small>{$t('The adapter does not enforce a filesystem sandbox.')}</small>{/if}
        {#if configuration?.networkAccess}<label class="check-row"><input type="checkbox" checked={selected.profile.networkAccess ?? false} onchange={(event) => updateProfile({ networkAccess: event.currentTarget.checked || undefined })} disabled={safeMode || busy || !['read-only', 'workspace-write'].includes(selected.profile.permissionMode)} />{$t('Allow network access')}</label><small>{$t('Grants this Codex profile native outbound network access. It is disabled by default.')}</small>{/if}
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
  .system-editor { color:var(--piui-text); height:100%; min-height:0; display:flex; flex-direction:column; background:var(--piui-bg); }
  .toolbar { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:10px 16px; min-height:58px; border-bottom:1px solid var(--piui-border-subtle); background:var(--piui-bg-raised); }
  .document-identity,.document-actions,.document-title { display:flex; align-items:center; min-width:0; }
  .document-identity { gap:10px; flex:1 1 auto; }
  .document-title { flex-direction:column; align-items:flex-start; gap:1px; }
  .document-dot { width:8px; height:8px; flex:0 0 auto; border-radius:50%; background:var(--piui-success); box-shadow:0 0 0 3px color-mix(in srgb,var(--piui-success) 16%,transparent); }
  .document-dot.dirty-dot { background:var(--piui-accent); box-shadow:0 0 0 3px color-mix(in srgb,var(--piui-accent) 16%,transparent); }
  .document-actions { justify-content:flex-end; flex-wrap:wrap; gap:6px; }
  .action-divider { width:1px; height:22px; margin:0 4px; background:var(--piui-border-subtle); }
  input,select,textarea,button { font:inherit; color:var(--piui-text); border:1px solid var(--piui-border); background:var(--piui-bg-raised); border-radius:var(--piui-radius-sm); padding:6px 9px; min-width:0; min-height:30px; }
  button { cursor:pointer; transition:background-color 140ms ease,border-color 140ms ease,transform 140ms ease; } button:hover:not(:disabled) { background:var(--piui-surface-2); } button:active:not(:disabled) { transform:translateY(1px); } button:disabled { opacity:.5; cursor:default; }
  input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible,.canvas:focus-visible,summary:focus-visible { outline:2px solid var(--piui-focus); outline-offset:2px; }
  .system-name { font-size:15px; font-weight:650; letter-spacing:-.01em; border-color:transparent; background:transparent; padding:1px 3px; flex:1; min-width:180px; } .system-name:focus { background:var(--piui-bg); border-color:var(--piui-border); }
  .document-actions > select { max-width:180px; } .save-state { color:var(--piui-text-faint); font-size:11px; padding-left:3px; } .toolbar-secondary { background:transparent; border-color:var(--piui-border-subtle); } .primary { background:var(--piui-action); color:var(--piui-action-ink); border-color:transparent; font-weight:650; } .primary:hover:not(:disabled) { background:var(--piui-action); filter:brightness(1.1); } .run-action span { margin-left:3px; font-size:14px; }
  .graph-layout { flex:1; display:grid; grid-template-columns:minmax(0,1fr); min-height:0; } .graph-layout.has-selection { grid-template-columns:minmax(0,1fr) var(--graph-inspector-width); }
  .canvas-column { min-width:0; min-height:0; display:flex; flex-direction:column; }
  .canvas-tools { display:flex; align-items:center; gap:6px; padding:8px 14px; min-height:48px; border-bottom:1px solid var(--piui-border-subtle); background:var(--piui-surface-1); flex-wrap:wrap; font-size:12px; }
  .canvas-tools button,.canvas-tools select { border-color:transparent; background:transparent; } .canvas-tools button:hover:not(:disabled),.canvas-tools select:hover:not(:disabled) { background:var(--piui-surface-2); } .tool-primary { color:var(--piui-text); border-color:var(--piui-border) !important; background:var(--piui-bg-raised) !important; font-weight:600; } .tool-icon { color:var(--piui-accent); font-size:16px; line-height:0; } .spacer { flex:1; min-width:12px; }
  .edge-legend { display:flex; gap:10px; align-items:center; color:var(--piui-text-faint); font-size:10px; white-space:nowrap; } .edge-legend span { display:flex; align-items:center; gap:4px; } .legend-line { width:15px; height:0; border-top:2px solid var(--piui-text-muted); } .legend-line.message-line { border-top-style:dashed; } .legend-line.observe-line { border-top-style:dotted; border-color:var(--piui-accent); } .canvas-summary { color:var(--piui-text-faint); font-size:10px; white-space:nowrap; font-variant-numeric:tabular-nums; }
  .zoom-controls { display:flex; align-items:center; flex-shrink:0; border:1px solid var(--piui-border-subtle); border-radius:var(--piui-radius-sm); overflow:hidden; } .zoom-controls button { border:0; border-radius:0; min-width:30px; padding:5px 7px; } .zoom-controls button + button { border-left:1px solid var(--piui-border-subtle); } .inspector-reopen { color:var(--piui-accent); }
  .canvas { position:relative; overflow:auto; flex:1; min-height:0; background-color:var(--piui-bg); background-image:radial-gradient(var(--piui-border-subtle) .7px,transparent .7px); background-size:20px 20px; }
  .world { position:relative; transform-origin:0 0; } svg { position:absolute; pointer-events:none; } svg > path { pointer-events:stroke; fill:none; stroke:var(--piui-text-faint); stroke-width:1.8; transition:stroke .14s ease,opacity .14s ease,stroke-width .14s ease; } svg > path.secondary-edge { stroke:var(--piui-text-muted); stroke-dasharray:5 5; } svg > path.spawn-edge { stroke:var(--piui-accent); } svg > path.observe-edge { stroke-dasharray:2 6; } svg > path.muted-edge { opacity:.18; } svg > path.related-edge { stroke-width:2.3; } svg > path.selected-edge { stroke:var(--piui-accent); stroke-width:2.8; opacity:1; }
  .node-shell { position:absolute; width:232px; }
  .node { position:relative; width:232px; min-height:124px; box-sizing:border-box; display:grid; gap:5px; align-content:start; text-align:left; padding:13px 16px; touch-action:none; user-select:none; background:var(--piui-bg-raised); border-radius:12px; box-shadow:0 8px 22px color-mix(in srgb,var(--piui-bg) 70%,transparent); }
  .node:hover { border-color:var(--piui-border-strong); transform:translateY(-1px); } .node.selected { border-color:var(--piui-action); background:color-mix(in srgb,var(--piui-bg-raised) 88%,var(--piui-accent-soft)); box-shadow:0 0 0 1px var(--piui-action),0 10px 26px color-mix(in srgb,var(--piui-action) 18%,transparent); } .node.node-related { border-color:color-mix(in srgb,var(--piui-accent) 55%,var(--piui-border)); }
  .node-topline { display:flex; justify-content:space-between; align-items:center; gap:8px; } .node strong { font-size:14px; font-weight:650; letter-spacing:-.01em; overflow-wrap:anywhere; } .node span,.node small { color:var(--piui-text-muted); overflow-wrap:anywhere; font-size:11px; } .node .harness { color:var(--piui-accent); font-size:10px; letter-spacing:.04em; text-transform:uppercase; } .node-kind { color:var(--piui-text-faint) !important; font-size:9px !important; text-transform:uppercase; letter-spacing:.06em; } .node-model { color:var(--piui-text) !important; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .node-task { display:-webkit-box; line-clamp:2; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; min-height:28px; line-height:1.35; color:var(--piui-text-muted) !important; }
  .port { position:absolute; top:47px; width:38px; height:38px; min-height:38px; padding:0; border:0; background:transparent; border-radius:50%; touch-action:none; } .port::before { content:''; position:absolute; top:18px; width:13px; border-top:1px solid var(--piui-border-strong); } .port::after { content:''; position:absolute; top:13px; width:11px; height:11px; border:2px solid var(--piui-border-strong); border-radius:50%; background:var(--piui-bg); } .port-in { left:-25px; } .port-in::before { right:7px; } .port-in::after { right:0; } .port-out { right:-25px; } .port-out::before { left:7px; } .port-out::after { left:0; }
  .port:hover::after,.port.connecting::after,.port:focus-visible::after { background:var(--piui-accent); border-color:var(--piui-accent); } svg > path:hover { stroke:var(--piui-accent); stroke-width:2.8; opacity:1; } svg > path.connection-preview { stroke:var(--piui-accent); stroke-dasharray:5 5; }
  .connection-status { display:flex; align-items:center; gap:8px; padding:7px 14px; font-size:12px; color:var(--piui-text-muted); background:var(--piui-accent-soft); border-bottom:1px solid var(--piui-border-subtle); }
  aside { position:relative; min-width:0; min-height:0; border-left:1px solid var(--piui-border-subtle); padding:18px; display:flex; flex-direction:column; gap:12px; overflow:auto; background:var(--piui-bg-raised); } .inspector-heading { display:flex; align-items:center; justify-content:space-between; padding-bottom:12px; border-bottom:1px solid var(--piui-border-subtle); } .eyebrow { display:block; color:var(--piui-text-faint); font-size:10px; letter-spacing:.08em; text-transform:uppercase; margin-bottom:4px; } aside h2 { font-size:15px; margin:0; font-weight:650; overflow-wrap:anywhere; } .close-inspector { border:0; padding:0; width:28px; min-height:28px; font-size:18px; color:var(--piui-text-muted); background:transparent; }
  aside label { display:grid; gap:5px; font-size:12px; color:var(--piui-text-muted); } aside label input,aside label select,textarea { background:var(--piui-bg); } aside small { color:var(--piui-text-faint); font-size:11px; line-height:1.45; } textarea { min-height:78px; resize:vertical; } .danger { color:var(--piui-danger-text); background:transparent; border-color:transparent; margin-top:auto; text-align:left; }
  .connections { border-top:1px solid var(--piui-border-subtle); padding:10px 14px; font-size:12px; background:var(--piui-bg-raised); } summary { cursor:pointer; } summary span { color:var(--piui-text-faint); margin-left:8px; } .connection-form { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; } .connection-form select { flex:1; } ul { list-style:none; margin:7px 0 0; padding:0; max-height:180px; overflow:auto; } li { display:flex; gap:6px; align-items:center; padding:2px 0; border-radius:var(--piui-radius-sm); } li.selected-connection { background:var(--piui-accent-soft); } .connection-link { flex:1; display:grid; gap:2px; min-width:0; border:0; background:transparent; text-align:left; padding:6px 8px; } .connection-link span { overflow-wrap:anywhere; } .connection-link b { color:var(--piui-accent); font-weight:500; } li small { color:var(--piui-text-faint); } .connection-remove { flex:0 0 auto; border:0; background:transparent; color:var(--piui-text-faint); }
  .empty { position:absolute; top:80px; left:10%; right:10%; z-index:1; text-align:center; padding:30px; border:1px dashed var(--piui-border); border-radius:var(--piui-radius-lg); background:color-mix(in srgb,var(--piui-bg-raised) 70%,transparent); } .empty h2 { font-size:20px; font-weight:600; margin:0 0 8px; } .empty p { font-size:13px; color:var(--piui-text-muted); margin-bottom:20px; } .notice,.errors { padding:8px 14px; font-size:12px; } .errors { color:var(--piui-danger-text); background:var(--piui-danger-surface); } .errors p { margin:4px 0; }
  @media(max-width:1100px) { .edge-legend { display:none; } .toolbar { align-items:flex-start; flex-direction:column; } .document-actions { width:100%; justify-content:flex-start; } }
  @media(max-width:900px) { .canvas-summary { display:none; } .document-actions > select { max-width:140px; } }
  @media(max-width:700px) { .graph-layout.has-selection { grid-template-columns:1fr; grid-template-rows:minmax(160px,1fr) minmax(0,1fr); } aside { border-left:0; border-top:1px solid var(--piui-border-subtle); } .canvas-tools { align-items:flex-start; } .zoom-controls { margin-left:auto; } }
</style>
