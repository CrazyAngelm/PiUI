<script lang="ts">
  import { connectAgents, connectRoute, visibleConnections, type ConnectionDirection } from './graphConnections';
  import { preflightGraph, type PreflightIssue } from './graphPreflight';
  import { performRunAction } from './runActions';
  import { onMount, tick } from 'svelte';
  import PanelResize from '../../components/PanelResize.svelte';
  import { modalFocus } from '../workspace/workspaceUx';
  import { harnessModels } from '../../host-api/harnessModels';
  import type { HarnessCatalogModel as WorkspaceModel } from '../../../../../contracts/harness-models-v18';
  import type { HarnessModelsResult } from '../../../../../contracts/harness-models-v18';
  import FlowSettings from './FlowSettings.svelte';
  import ResultFields from './ResultFields.svelte';
  import ResourcePicker from './ResourcePicker.svelte';
  import { harnessConfiguration, permissionLabels } from '../../harness-adapters';
  import { t } from '../locale/language';
  import { orchestrationHost, orchestrationError, type OrchestrationClient, type DefinitionSummary, type AgentProfile, type SaveDefinitionRequest, type StoredDefinition } from '../../host-api/orchestrationClient';
  import { emptyGraph, newGraphNode, newRouterNode, compileGraph, graphIssues, patternEdges, placeholderProfile, type AgentGraph, type GraphNode, type ConnectionKind } from './agentGraph';
  import { arrangeResultDependencies, unoccupiedPosition, graphNodeHeight, graphBounds, GRAPH_NODE_WIDTH, GRAPH_PORT_Y } from './graphLayout';
  import RouterSettings from './RouterSettings.svelte';
  import GraphCanvas from '../../components/GraphCanvas.svelte';
  import { GraphHistory, duplicateNode } from './graphHistory';
  export let modelsFor: (harness: AgentProfile['harness']) => import('../../../../../contracts/harness-models-v18').HarnessCatalogModel[] = () => [];
  export let workspaceId: string;
  export let safeMode = false;
  export let onDirtyChange: (dirty: boolean) => void = () => {};
  export let onRun: (run: import('../../../../../contracts/orchestration-v6').OrchestrationRunV6) => void = () => {};
  export let onLibrary: () => void = () => {};
  export let client: OrchestrationClient = orchestrationHost;
  let graph = emptyGraph();
  let baseline = JSON.stringify(graph);
  let commands: readonly DefinitionSummary[] = [];
  let revisions = new Map<string, number>();
  let selectedId = '';
  let busy = false;
  let operation: 'save' | 'open' | 'check' | 'import' | undefined;
  let viewport: GraphCanvas;
  let nodeHeights = new Map<string, number>();
  function measureNode(element: HTMLElement, id: string) {
    const observer = new ResizeObserver(() => { const height = element.offsetHeight; if (nodeHeights.get(id) !== height) nodeHeights = new Map(nodeHeights).set(id, height); });
    observer.observe(element);
    return { destroy() { observer.disconnect(); nodeHeights.delete(id); nodeHeights = new Map(nodeHeights); } };
  }
  let history = new GraphHistory(graph);
  let undoAvailable = false, redoAvailable = false, editingField = false;
  let pendingNavigation: (() => void | Promise<void>) | undefined;
  let pendingPattern = '';
  let nodeQuery = '', modelQuery = '', systemQuery = '';
  let connectionsOpen = false;
  let savedProfiles: readonly DefinitionSummary[] = [];
  let copyProfileId = '';
  let checkedStamp = '';
  let validationShown = false;
  $: validationIssues = validationShown ? graphIssues(graph) : [];
  $: graphStamp = JSON.stringify(graph);
  $: if (!drag && !editingField) { history.record(graph); undoAvailable = history.canUndo; redoAvailable = history.canRedo; }
  $: if (checkedStamp && checkedStamp !== graphStamp) { preflightIssues = []; preflightNotice = 'System changed. Check it again.'; }
  $: matchingNodes = graph.nodes.filter(node => `${node.profile.name} ${node.profile.model}`.toLocaleLowerCase().includes(nodeQuery.toLocaleLowerCase()));
  $: matchingCommands = commands.filter(command => command.name.toLocaleLowerCase().includes(systemQuery.toLocaleLowerCase()));
  function resetHistory(): void { validationShown = false; history.reset(graph); history = history; checkedStamp = ''; preflightIssues = []; preflightNotice = ''; errors = []; cancelConnection(); selectedEdgeKey = ''; }
  function travel(redo = false): void { if (safeMode || busy) return; history.record(graph); const next = redo ? history.redo() : history.undo(); if (next) { graph = next; history = history; if (!graph.nodes.some(node => node.id === selectedId)) selectedId = ''; } }
  function navigate(action: () => void | Promise<void>): void { if (dirty) pendingNavigation = action; else void action(); }
  async function continueNavigation(saveFirst: boolean): Promise<void> { if (saveFirst && !await save()) return; const action = pendingNavigation; pendingNavigation = undefined; await action?.(); }
  async function focusNode(id: string): Promise<void> { selectedId = id; inspectorCollapsed = false; await tick(); const node = graph.nodes.find(node => node.id === id); if (node) await viewport.focusBounds({ left: node.x, top: node.y, right: node.x + GRAPH_NODE_WIDTH, bottom: node.y + (nodeHeights.get(node.id) ?? graphNodeHeight(node)) }); canvas?.querySelector<HTMLButtonElement>('.node.selected')?.focus({preventScroll:true}); }
  function copySelected(): void { if (!selected || safeMode || busy) return; const node = duplicateNode(selected, $t('Copy of {0}', [selected.profile.name])); Object.assign(node, unoccupiedPosition(graph.nodes,node,graphNodeHeight(node),nodeHeights)); graph = {...graph,nodes:[...graph.nodes,node]}; void focusNode(node.id); }
  async function addProfile(): Promise<void> {
    if (!copyProfileId || safeMode || busy) return;
    busy = true;
    try { const stored = await client.orchestration_get_profile_v6({workspaceId,id:copyProfileId}); if (!stored) throw Error('Missing agent profile'); const node = newGraphNode(graph.nodes.length); node.profile = {...structuredClone(stored.value),id:crypto.randomUUID(),allowedSpawnProfileIds:[]}; Object.assign(node, unoccupiedPosition(graph.nodes,node,graphNodeHeight(node),nodeHeights)); graph = {...graph,nodes:[...graph.nodes,node]}; copyProfileId = ''; void focusNode(node.id); }
    catch (error) { errors = [orchestrationError(error).message]; } finally { busy = false; }
  }
  function graphKeys(event: KeyboardEvent): void {
    if ((event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); travel(event.shiftKey); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); travel(true); }
  }
  let preflightIssues: PreflightIssue[] = [];
  let preflightNotice = '';
  let errors: string[] = [];
  let from = '';
  let to = '';
  let kind: ConnectionKind = 'result';
  let direction: ConnectionDirection = 'forward';
  let world: HTMLDivElement;
  let connectionStart: { id: string; side: 'in' | 'out' | 'route'; branchId?: string } | undefined;
  let connectionPoint: { x: number; y: number } | undefined;
  let connectionPointer: number | undefined;
  let connectionError = '';
  let selectedEdgeKey = '';
  let canvas: HTMLDivElement;
  let inspectorCollapsed = false;
  let inspectedNodeId = '';
  let modelOptionsOpen = false;
  let flowOptionsOpen = false;
  let accessOptionsOpen = false;
  let subagentsOpen = false;
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
  let placementKind: 'agent' | 'router' | undefined;
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
  $: if (mounted && selected && selected.kind !== 'router' && !safeMode && selected.profile.harness !== catalogHarness) void loadModels(selected.profile.harness);
  $: nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  let drag: { id: string; pointer: number; startX: number; startY: number; x: number; y: number } | undefined;
  $: availableModels = selected ? modelCatalogs[selected.profile.harness] ?? modelsFor(selected.profile.harness) : [];
  $: nativeModel = selected ? availableModels.find(model => model.id === selected.profile.model && model.provider === selected.profile.modelProvider) : undefined;
  $: configuration = selected ? harnessConfiguration(selected.profile.harness) : undefined;
  $: selected = graph.nodes.find(node => node.id === selectedId);
  $: if (selectedId !== inspectedNodeId) {
    inspectedNodeId = selectedId; modelQuery = '';
    const inspected = graph.nodes.find(node => node.id === selectedId);
    modelOptionsOpen = inspected?.profile.serviceTier === 'fast';
    flowOptionsOpen = inspected?.requireApproval === true || (inspected?.inputBindings?.length ?? 0) > 0 || inspected?.condition !== undefined || inspected?.review !== undefined;
    accessOptionsOpen = inspected !== undefined && inspected.profile.permissionMode !== 'native';
    subagentsOpen = graph.edges.some(edge => edge.from === selectedId && edge.kind === 'spawn');
  }
  $: if (modelsError) modelOptionsOpen = true;
  $: if (
    selected !== undefined
    && (selected.kind !== 'router' || selected.router?.mode === 'agent')
    && (!configuration?.filesystemSandbox || (resourceCatalogs[selected.profile.harness]?.warnings.length ?? 0) > 0)
  ) accessOptionsOpen = true;
  $: dirty = JSON.stringify(graph) !== baseline;
  $: onDirtyChange(dirty);
  $: width = graph.nodes.length ? graphBounds(graph.nodes, undefined, nodeHeights).right : 0;
  $: height = graph.nodes.length ? graphBounds(graph.nodes, undefined, nodeHeights).bottom : 0;
  onMount(() => { mounted = true; void refresh(); return () => { mounted = false; onDirtyChange(false); if (downloadUrl) URL.revokeObjectURL(downloadUrl); }; });
  async function importFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0]; input.value = '';
    if (!file || safeMode || busy) return;
    if (dirty) { pendingNavigation = () => importPickedFile(file); return; }
    await importPickedFile(file);
  }
  async function importPickedFile(file: File): Promise<void> {
    busy = true; operation = 'import'; errors = [];
    try {
      const { parseSystemFile, systemFileToGraph } = await import('./systemFile');
      const next = systemFileToGraph(parseSystemFile(await file.text()));
      graph = next; revisions = new Map(); selectedId = next.nodes[0]?.id ?? ''; pendingRunId = undefined; fileNotice = 'Imported as a new system. Save to keep it.'; resetHistory(); await tick(); await viewport.reset();
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
  async function refresh(): Promise<void> { try { const catalog = await client.orchestration_catalog_v6({ workspaceId }); commands = catalog.launchCommands; savedProfiles = catalog.profiles; } catch (error) { errors = [orchestrationError(error).message]; } }
  function syncRouterInputs(nodes: GraphNode[], edges: readonly { from: string; to: string; kind?: ConnectionKind }[]): GraphNode[] {
    return nodes.map(node => {
      if (node.kind !== 'router' || !node.router) return node;
      const inputStepId = edges.find(edge => edge.kind === 'result' && edge.to === node.id)?.from ?? '';
      return node.router.inputStepId === inputStepId ? node : { ...node, router: { ...node.router, inputStepId } };
    });
  }
  async function selectRouterInput(nodeId: string): Promise<void> { await focusNode(nodeId); }
  function updateNode(id: string, change: Partial<GraphNode>): void { graph = { ...graph, nodes: graph.nodes.map(node => node.id === id ? { ...node, ...change } : node) }; }
  function updateRouterNode(id: string, change: Partial<GraphNode>): void {
    const requestedInput = change.router?.inputStepId;
    if (requestedInput === undefined) { updateNode(id, change); return; }
    let edges = graph.edges.filter(edge => !(edge.kind === 'result' && edge.to === id));
    if (requestedInput) {
      const result = connectAgents({ ...graph, edges }, requestedInput, id, 'result', 'forward');
      if (result.error) { connectionError = result.error; return; }
      edges = result.edges;
    }
    const nodes = graph.nodes.map(node => node.id === id ? { ...node, ...change } : node);
    graph = { ...graph, nodes: syncRouterInputs(nodes, edges), edges };
    connectionError = '';
  }
  function updateProfile(change: Partial<AgentProfile>): void { if (selected) updateNode(selected.id, { profile: { ...selected.profile, ...change } }); }
  function add(nodeKind: 'agent' | 'router' = placementKind ?? 'agent', point: { x: number; y: number } | undefined = undefined): void {
    const node = nodeKind === 'router' ? newRouterNode(graph.nodes.length) : newGraphNode(graph.nodes.length);
    const center = !point && canvas ? { x: (canvas.scrollLeft + canvas.clientWidth / 2) / zoom, y: (canvas.scrollTop + canvas.clientHeight / 2) / zoom } : point;
    if (center) { node.x = Math.max(24, center.x - 116); node.y = Math.max(24, center.y - 62); }
    if (!point) Object.assign(node, unoccupiedPosition(graph.nodes,node,graphNodeHeight(node),nodeHeights));
    graph = { ...graph, nodes: [...graph.nodes, node] }; if (!point) void focusNode(node.id); selectedId = node.id; placementKind = undefined; inspectorCollapsed = false;
  }
  function armPlacement(nodeKind: 'agent' | 'router'): void { placementKind = placementKind === nodeKind ? undefined : nodeKind; connectionError = ''; }
  function canvasClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const edgeTarget = target.closest<SVGElement>('[data-edge-to]');
    if (edgeTarget?.dataset.edgeTo) { selectedEdgeKey = edgeTarget.dataset.edgeKey ?? ''; connectionsOpen = true; void focusNode(edgeTarget.dataset.edgeTo); return; }
    if (!placementKind || safeMode || busy || !world) return;
    if (target.closest('.node-shell') || target.closest('[data-port]')) return;
    const bounds = world.getBoundingClientRect();
    add(placementKind, { x: (event.clientX - bounds.left) / zoom, y: (event.clientY - bounds.top) / zoom });
  }
  function remove(): void {
    const edges = graph.edges.filter(edge => edge.from !== selectedId && edge.to !== selectedId);
    const nodes = graph.nodes.filter(node => node.id !== selectedId);
    graph = { ...graph, nodes: syncRouterInputs(nodes, edges), edges };
    selectedId = '';
  }
  function removeEdge(index: number): void {
    const edges = graph.edges.filter((_, position) => position !== index);
    graph = { ...graph, nodes: syncRouterInputs(graph.nodes, edges), edges };
    selectedEdgeKey = '';
  }
  function connect(): void {
    if (safeMode || busy) return;
    const result = connectAgents(graph, from, to, kind, direction);
    connectionError = result.error ?? '';
    if (!result.error) graph = { ...graph, nodes: syncRouterInputs(graph.nodes, result.edges), edges: result.edges };
  }
  function cancelConnection(): void { connectionStart = undefined; connectionPoint = undefined; connectionPointer = undefined; }
  function finishConnection(id: string, side: 'in' | 'out' | 'route', branchId: string | undefined = undefined): void {
    if (!connectionStart || safeMode || busy) return;
    const startIsOutput = connectionStart.side === 'out' || connectionStart.side === 'route';
    const endIsOutput = side === 'out' || side === 'route';
    if (startIsOutput === endIsOutput || (connectionStart.side === 'route' && side !== 'in') || (side === 'route' && connectionStart.side !== 'in')) { connectionError = 'Connect an output to an input.'; cancelConnection(); return; }
    const routerId = connectionStart.side === 'route' ? connectionStart.id : side === 'route' ? id : '';
    const selectedBranch = connectionStart.side === 'route' ? connectionStart.branchId : branchId;
    if (routerId && selectedBranch) {
      const targetId = connectionStart.side === 'route' ? id : connectionStart.id;
      const result = connectRoute(graph, routerId, targetId, selectedBranch);
      connectionError = result.error ?? '';
      if (!result.error) graph = { ...graph, edges: result.edges };
    } else {
      from = connectionStart.side === 'out' ? connectionStart.id : id;
      to = connectionStart.side === 'in' ? connectionStart.id : id;
      connect();
    }
    cancelConnection();
  }
  function portClick(event: MouseEvent, id: string, side: 'in' | 'out' | 'route', branchId: string | undefined = undefined): void {
    if (safeMode || busy) return;
    // Pointer gestures are handled on release; keyboard activation uses click.
    if (event.detail !== 0) return;
    if (connectionStart) finishConnection(id, side, branchId);
    else { connectionStart = { id, side, branchId }; connectionError = ''; }
  }
  function portDown(event: PointerEvent, id: string, side: 'in' | 'out' | 'route', branchId: string | undefined = undefined): void {
    if (safeMode || busy || event.button !== 0) return;
    event.stopPropagation();
    if (!connectionStart) { connectionStart = { id, side, branchId }; connectionError = ''; }
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
    const branchId = port.dataset.branchId;
    if (!id || (side !== 'in' && side !== 'out' && side !== 'route')) { cancelConnection(); return; }
    if (id !== connectionStart.id || side !== connectionStart.side || branchId !== connectionStart.branchId) finishConnection(id, side, branchId);
  }
  function branchY(node: GraphNode, branchId: string | undefined = undefined): number { const index = node.router?.branches.findIndex(branch => branch.id === branchId) ?? -1; return index >= 0 ? 55 + index * 28 : GRAPH_PORT_Y; }
  function edgePath(source: GraphNode, target: GraphNode, sourcePortY = GRAPH_PORT_Y, targetPortY = GRAPH_PORT_Y): string {
    if (source.id === target.id) return `M ${source.x + GRAPH_NODE_WIDTH} ${source.y + sourcePortY} C ${source.x + GRAPH_NODE_WIDTH + 60} ${source.y - 60}, ${source.x - 60} ${source.y - 60}, ${source.x} ${source.y + targetPortY}`;
    const sign = source.x <= target.x ? 1 : -1;
    const x1 = source.x + (sign === 1 ? GRAPH_NODE_WIDTH : 0), x2 = target.x + (sign === 1 ? 0 : GRAPH_NODE_WIDTH);
    return `M ${x1} ${source.y + sourcePortY} C ${x1 + sign * 50} ${source.y + sourcePortY}, ${x2 - sign * 50} ${target.y + targetPortY}, ${x2} ${target.y + targetPortY}`;
  }
  function edgeKey(edge: { from: string; to: string; kind?: ConnectionKind; branchId?: string }): string { return `${edge.from}:${edge.to}:${edge.kind ?? ''}:${edge.branchId ?? ''}`; }
  function edgeIsSelected(edge: { from: string; to: string; kind?: ConnectionKind; branchId?: string; connections?: readonly { from: string; to: string; kind?: ConnectionKind; branchId?: string }[] }): boolean {
    return selectedEdgeKey === edgeKey(edge) || (edge.connections?.some(connection => selectedEdgeKey === edgeKey(connection)) ?? false);
  }
  function connectionLabel(connection: ConnectionKind): string {
    return connection === 'result' ? 'Result dependency' : connection === 'send' ? 'Messaging' : connection === 'observe' ? 'Observation' : connection === 'spawn' ? 'Delegation' : 'Route';
  }
  function arrange(): void {
    const result = arrangeResultDependencies(graph.nodes, graph.edges, nodeHeights);
    if (result.cycle) { connectionError = 'Arrange requires an acyclic result graph.'; return; }
    graph = { ...graph, nodes: result.nodes };
    connectionError = '';
    selectedEdgeKey = '';
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
  function requestNew(): void { navigate(async () => { graph = emptyGraph(); baseline = JSON.stringify(graph); revisions = new Map(); selectedId = ''; pendingRunId = undefined; resetHistory(); await tick(); await viewport.reset(); }); }
  async function open(id: string, bypassDirty = false): Promise<void> {
    if (!id || busy) return;
    if (dirty && !bypassDirty) { pendingNavigation = () => open(id, true); return; }
    busy = true; operation = 'open'; errors = [];
    try {
      const command = await client.orchestration_get_launch_command_v6({ workspaceId, id }); if (!command) throw new Error('Missing command');
      const [team, pipeline, catalog] = await Promise.all([client.orchestration_get_team_v6({ workspaceId, id: command.value.teamId }), client.orchestration_get_pipeline_v6({ workspaceId, id: command.value.pipelineId }), client.orchestration_catalog_v6({ workspaceId })]);
      if (!team || !pipeline) throw new Error('Missing graph definition');
      const storedProfiles = await Promise.all(catalog.profiles.map(profile => client.orchestration_get_profile_v6({ workspaceId, id: profile.id })));
      const profiles = new Map(storedProfiles.filter((profile): profile is StoredDefinition<AgentProfile> => profile !== null).map(profile => [profile.value.id, profile]));
      const nodes = pipeline.value.steps.map((step, index) => {
        const isProgramRouter = step.router?.mode === 'program';
        // Program routers and scripts have no team member; their placeholder profile only names the step.
        const isScript = step.executor?.type === 'script';
        const member = team.value.members.find(item => item.id === step.assignedMemberId);
        const profile = member && profiles.get(member.profileId);
        const fallbackProfile: AgentProfile = placeholderProfile(step.name || (isScript ? `Script ${index + 1}` : `Router ${index + 1}`), isScript ? 'script' : 'router');
        if (!profile && !isProgramRouter && !isScript) throw new Error('Missing agent profile');
        return { kind: step.router ? 'router' as const : 'agent' as const, id: step.id, ...(step.executor ? { executor: step.executor } : {}), ...(step.pinnedOutput ? { pinnedOutput: step.pinnedOutput } : {}), profile: profile?.value ?? fallbackProfile, router: step.router, task: step.instructions, inputBindings: step.inputBindings ? [...step.inputBindings] : undefined, condition: step.condition, review: step.review, requireApproval: step.requireApproval, resultFields: step.resultFields ? [...step.resultFields] : undefined, executionMode: step.executionMode, input: step.inputInstructions, x: 60 + index * 280, y: 100 };
      });
      // A member may own several steps in older definitions; preserve the original editors for those graphs.
      if (new Set(nodes.filter(node => node.kind !== 'router' || node.router?.mode === 'agent').map(node => node.profile.id)).size !== nodes.filter(node => node.kind !== 'router' || node.router?.mode === 'agent').length || team.value.members.some(member => !pipeline.value.steps.some(step => step.id === member.id && step.assignedMemberId === member.id))) throw new Error('This definition uses reusable members. Open it in Library to preserve its assignments.');
      const next: AgentGraph = { id, name: command.value.name, teamId: team.value.id, pipelineId: pipeline.value.id, orchestratorId: team.value.orchestratorMemberId, spawnedAgentsJoinTeam: team.value.spawnedAgentsJoinTeam, ...(pipeline.value.inputs ? { inputs: pipeline.value.inputs.map(input => ({ ...input })) } : {}), nodes, edges: [
        ...pipeline.value.steps.flatMap(step => [
          ...step.dependencyStepIds.filter(dependency => !(step.routeGates ?? []).some(gate => gate.routerStepId === dependency)).map(dependency => ({ from: dependency, to: step.id, kind: 'result' as const })),
          ...(step.routeGates ?? []).map(gate => ({ from: gate.routerStepId, to: step.id, kind: 'route' as const, branchId: gate.branchId })),
        ]),
        ...team.value.sendEdges.map(edge => ({ from: edge.fromMemberId, to: edge.toMemberId, kind: 'send' as const })),
        ...team.value.observeEdges.map(edge => ({ from: edge.fromMemberId, to: edge.toMemberId, kind: 'observe' as const })),
        ...nodes.filter(node => node.kind !== 'router' || node.router?.mode === 'agent').flatMap(node => node.profile.allowedSpawnProfileIds.map(profileId => { const target = nodes.find(candidate => candidate.profile.id === profileId); if (!target) throw new Error('This definition delegates to an external profile. Open it in Library.'); return { from: node.id, to: target.id, kind: 'spawn' as const }; })),
      ] };
      try { const positions: unknown = JSON.parse(localStorage.getItem(`piui.graph.${workspaceId}.${id}`) ?? 'null'); if (Array.isArray(positions)) for (const position of positions) if (position && typeof position.id === 'string' && Number.isFinite(position.x) && Number.isFinite(position.y)) { const node = next.nodes.find(item => item.id === position.id); if (node) { node.x = Math.max(0, position.x); node.y = Math.max(0, position.y); } } } catch { /* Positions are rebuildable UI metadata. */ }
      graph = next; baseline = JSON.stringify(graph); selectedId = nodes[0]?.id ?? ''; pendingRunId = undefined; resetHistory();
      revisions = new Map([[id, command.revision], [team.value.id, team.revision], [pipeline.value.id, pipeline.revision], ...nodes.filter(node => profiles.has(node.profile.id)).map(node => [node.profile.id, profiles.get(node.profile.id)!.revision] as [string, number])]);
    } catch (error) { errors = [error instanceof Error && !('code' in error) ? error.message : orchestrationError(error).message]; }
    finally { busy = false; }
  }
  async function checkSystem(): Promise<boolean> {
    preflightNotice = ''; preflightIssues = []; errors = []; validationShown = true; checkedStamp = JSON.stringify(graph);
    if (graphIssues(graph).length) return false;
    const issues = await preflightGraph(graph, harness => harnessModels({ workspaceId, harness }, true));
    preflightIssues = issues;
    if (!issues.length) preflightNotice = 'System and native settings verified. Launch permissions are checked again by the host.';
    return issues.length === 0;
  }
  async function checkOnly(): Promise<void> {
    if (busy || safeMode) return;
    busy = true; operation = 'check'; try { await checkSystem(); } finally { busy = false; }
  }
  async function save(run = false): Promise<boolean> {
    if (safeMode || busy) return false;
    errors = []; validationShown = true; if (graphIssues(graph).length) return false;
    busy = true; operation = 'save';
    try {
      if (run && !await checkSystem()) return false;
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
        else { pendingRunId = undefined; if (mounted) onRun(outcome.run); }
      }
    return true;
    } catch (error) { errors = [orchestrationError(error).message]; return false; }
    finally { busy = false; operation = undefined; }
  }
</script>

<svelte:window onpointermove={connectionMove} onpointerup={connectionUp} onpointercancel={cancelConnection} onkeydown={(event) => { if (event.key === 'Escape') { cancelConnection(); placementKind = undefined; } }} />

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Editor-scoped shortcuts and grouped field history.) -->
<section class="system-editor" onkeydown={graphKeys} onfocusin={(event) => { editingField = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement; }} onfocusout={() => { history.record(graph); history = history; editingField = false; }} inert={taskExpanded || pendingNavigation !== undefined} aria-label={$t('Agent system')}>
  <header class="toolbar">
    <div class="document-identity">
      <span class:dirty-dot={dirty} class="document-dot" aria-hidden="true"></span>
      <div class="document-title">
        <input class="system-name" aria-label={$t('Name')} placeholder={$t('Agent system')} bind:value={graph.name} disabled={safeMode || busy} />
        <span class="save-state" aria-live="polite">{$t(busy ? operation === 'save' ? 'Saving…' : operation === 'check' ? 'Checking…' : 'Loading…' : dirty ? 'Unsaved changes' : revisions.has(graph.id) ? 'Saved' : 'New draft')}</span>
      </div>
    </div>
    <div class="document-actions">
      <details class="open-system"><summary>{$t('Open system')}</summary><div><input class="system-search" aria-label={$t('Find system')} placeholder={$t('Find system')} bind:value={systemQuery} /><select aria-label={$t('Open system')} value={revisions.has(graph.id) ? graph.id : ''} onchange={(event) => void open(event.currentTarget.value)} disabled={busy}><option value="">{$t('Open system')}</option>{#each matchingCommands as command}<option value={command.id}>{command.name}</option>{/each}</select></div></details>
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
  {#if preflightIssues.length}<div class="errors" role="alert">{#each preflightIssues as issue}<button onclick={() => void focusNode(issue.nodeId)}>{graph.nodes.find(node => node.id === issue.nodeId)?.profile.name}: {$t(issue.message)}</button>{/each}</div>{/if}
  {#if validationIssues.length}<div class="errors" role="alert">{#each validationIssues as issue}<p>{$t(issue.message)} {#each issue.nodeIds as id}{@const node = nodeById.get(id)}{#if node}<button onclick={() => void focusNode(id)}>{node.profile.name || $t('Agent')}</button>{/if}{/each}</p>{/each}</div>{/if}
  {#if fileNotice}<p class="notice" role="status">{$t(fileNotice)}</p>{/if}
  {#if safeMode}<p class="notice">{$t('Safe mode: viewing only.')}</p>{/if}
  {#if errors.length}<div class="errors" role="alert">{#each errors as error}<p>{$t(error)}</p>{/each}{#if errors.some(error => error.includes('Open it in Library'))}<button onclick={() => navigate(onLibrary)}>{$t('Open library')}</button>{/if}</div>{/if}
  <div class="graph-layout" class:has-selection={selected !== undefined && !inspectorCollapsed} class:inspector-collapsed={inspectorCollapsed} style:--graph-inspector-width={`${inspectorWidth}px`}>
    <div class="canvas-column">
      <div class="canvas-tools">
        <div class="node-palette" role="toolbar" aria-label={$t('Node palette')}>
          <button class:palette-selected={placementKind === 'agent'} class="palette-agent" aria-pressed={placementKind === 'agent'} onclick={() => armPlacement('agent')} disabled={safeMode || busy}><span class="palette-glyph" aria-hidden="true">●</span>{$t('Agent')}</button>
          <button class:palette-selected={placementKind === 'router'} class="palette-router" aria-pressed={placementKind === 'router'} onclick={() => armPlacement('router')} disabled={safeMode || busy}><span class="palette-glyph" aria-hidden="true">◇</span>{$t('Router')}</button>
        </div>
        <button class="tool-primary" onclick={() => add()} disabled={safeMode || busy}><span class="tool-icon" aria-hidden="true">＋</span> {$t(placementKind === 'router' ? 'Add router' : 'Add agent')}</button>
        <details class="canvas-menu"><summary>{$t('Pattern')}</summary><select aria-label={$t('Pattern')} value="" onchange={(event) => { pendingPattern = event.currentTarget.value; event.currentTarget.value = ''; }} disabled={safeMode || busy || !graph.nodes.length}><option value="" disabled hidden>{$t('Pattern')}</option><option value="sequential">{$t('Sequential')}</option><option value="parallel">{$t('Parallel')}</option><option value="supervisor">{$t('Supervisor')}</option><option value="peer">{$t('Peer team')}</option></select></details>
        <details class="connection-options"><summary>{$t(connectionLabel(kind))}</summary><div>
        <select aria-label={$t('Connection type')} bind:value={kind} disabled={safeMode || busy}><option value="result">{$t('Result dependency')}</option><option value="send">{$t('Messaging')}</option><option value="observe">{$t('Observation')}</option><option value="spawn">{$t('Delegation')}</option></select>
        <select aria-label={$t('Direction')} bind:value={direction} disabled={safeMode || busy}><option value="forward">→ {$t('One way')}</option><option value="reverse">← {$t('Reverse')}</option><option value="both" disabled={kind === 'result'}>↔ {$t('Both ways')}</option></select>
        </div></details>
        <button onclick={arrange} disabled={safeMode || busy || graph.nodes.length < 2}>{$t('Arrange')}</button>
        <span class="spacer"></span>
        <details class="edge-help"><summary>{$t('Connections')}</summary><div class="edge-legend" aria-label={$t('Connection legend')}><span><i class="legend-line result-line"></i>{$t('Result dependency')}</span><span><i class="legend-line message-line"></i>{$t('Messaging')}</span><span><i class="legend-line observe-line"></i>{$t('Observation')}</span><span>{$t('Delegation')}</span><span>{$t('Route')}</span></div></details>

        {#if selected && inspectorCollapsed}<button class="inspector-reopen" onclick={() => inspectorCollapsed = false}>{$t('Show inspector')}</button>{/if}
      </div>
      <div class="document-tools">
        <button onclick={() => travel()} disabled={safeMode || busy || !undoAvailable}>{$t('Undo')}</button><button onclick={() => travel(true)} disabled={safeMode || busy || !redoAvailable}>{$t('Redo')}</button>
        <details><summary>{$t('Add from library')}</summary><p>{$t('Adds an independent copy without connections or delegation permissions.')}</p><select aria-label={$t('Saved profile')} bind:value={copyProfileId}><option value="">{$t('Select agent')}</option>{#each savedProfiles as profile}<option value={profile.id}>{profile.name}</option>{/each}</select><button onclick={() => void addProfile()} disabled={!copyProfileId || safeMode || busy}>{$t('Add copy')}</button><button onclick={() => navigate(onLibrary)}>{$t('Open library')}</button></details>
        <input type="search" aria-label={$t('Find node')} placeholder={$t('Find node')} bind:value={nodeQuery} />
        {#if nodeQuery}<div class="node-results">{#each matchingNodes as node}<button onclick={() => { void focusNode(node.id); nodeQuery = ''; }}>{node.profile.name}</button>{:else}<span>{$t('No matches')}</span>{/each}</div>{/if}
      </div>
      {#if pendingPattern}<div class="notice" role="group" aria-label={$t('Replace connections')}><p>{$t('This replaces every connection, including messaging, observation and delegation. You can undo it.')}</p><button disabled={safeMode || busy} onclick={() => { const edges = patternEdges(graph.nodes,pendingPattern); graph = {...graph, nodes:syncRouterInputs(graph.nodes,edges), edges}; pendingPattern = ''; }}>{$t('Replace connections')}</button><button onclick={() => pendingPattern = ''}>{$t('Cancel')}</button></div>{/if}
      {#if connectionStart}<div class="connection-status" role="status">{$t('Choose another port or press Escape.')}<button onclick={cancelConnection}>{$t('Cancel')}</button></div>{/if}
      {#if connectionError}<p class="errors" role="alert">{$t(connectionError)}</p>{/if}
<GraphCanvas bind:this={viewport} bind:canvas bind:world bind:zoom {width} {height} bounds={graph.nodes.length ? graphBounds(graph.nodes,undefined,nodeHeights) : undefined} label={$t('Agent system')} storageKey={`piui.graph.view.${workspaceId}.${graph.id}`} onclick={canvasClick}>
        <svelte:fragment slot="overlay">{#if placementKind}<div class="placement-hint" role="status">{$t(placementKind === 'router' ? 'Click the canvas to place a router.' : 'Click the canvas to place an agent.')} <button type="button" onclick={(event) => { event.stopPropagation(); placementKind = undefined; }}>{$t('Cancel')}</button></div>{/if}
        {#if !graph.nodes.length}<div class="empty"><h2>{$t('Agent system')}</h2><p>{$t('Add agents, then connect their results or allow communication.')}</p><button class="primary" onclick={() => add()} disabled={safeMode}>＋ {$t(placementKind === 'router' ? 'Add router' : 'Add agent')}</button></div>{/if}</svelte:fragment>

            <svg width={width} height={height} aria-hidden="true"><defs><marker id="graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" /></marker></defs>
              {#each renderedEdges as edge}{@const source = nodeById.get(edge.from)}{@const target = nodeById.get(edge.to)}{#if source && target}<path class="edge-hit" data-edge-to={edge.to} data-edge-key={edgeKey(edge)} d={edgePath(source, target, edge.kind === 'route' ? branchY(source, edge.branchId) : GRAPH_PORT_Y)} /><path data-edge-to={edge.to} data-edge-key={edgeKey(edge)} class:selected-edge={edgeIsSelected(edge)} class:related-edge={selected !== undefined && (edge.from === selected.id || edge.to === selected.id)} class:muted-edge={selected !== undefined && edge.from !== selected.id && edge.to !== selected.id} class:secondary-edge={edge.kind !== 'result'} class:spawn-edge={edge.kind === 'spawn'} class:observe-edge={edge.kind === 'observe'} class:route-edge={edge.kind === 'route'} d={edgePath(source, target, edge.kind === 'route' ? branchY(source, edge.branchId) : GRAPH_PORT_Y)} marker-start={edge.both ? 'url(#graph-arrow)' : undefined} marker-end="url(#graph-arrow)"><title>{edge.connections.map(connection => `${nodeById.get(connection.from)?.profile.name} → ${nodeById.get(connection.to)?.profile.name}: ${$t(connectionLabel(connection.kind))}${connection.branchId ? ` · ${source.router?.branches.find(branch => branch.id === connection.branchId)?.label ?? $t('Route')}` : ''}`).join('\n')}</title></path>{/if}{/each}
              {#if connectionStart && connectionPoint}{@const source = nodeById.get(connectionStart.id)}{#if source}<path class="connection-preview" d={`M ${source.x + ((connectionStart.side === 'out' || connectionStart.side === 'route') ? GRAPH_NODE_WIDTH : 0)} ${source.y + (connectionStart.side === 'route' ? branchY(source, connectionStart.branchId) : GRAPH_PORT_Y)} L ${connectionPoint.x} ${connectionPoint.y}`} marker-end="url(#graph-arrow)" />{/if}{/if}
            </svg>
            {#each graph.nodes as node (node.id)}<div class="node-shell" use:measureNode={node.id} class:router-shell={node.kind === 'router'} style:left={`${node.x}px`} style:top={`${node.y}px`} style:min-height={`${graphNodeHeight(node)}px`}>
              <button class="node" class:router-node={node.kind === 'router'} class:agent-node={node.kind !== 'router'} class:selected={node.id === selectedId} class:node-related={selected !== undefined && node.id !== selected.id && graph.edges.some((edge) => (edge.from === selected.id && edge.to === node.id) || (edge.to === selected.id && edge.from === node.id))} aria-pressed={node.id === selectedId} onpointerdown={(event) => pointerDown(event, node)} onpointermove={pointerMove} onpointerup={() => drag = undefined} onpointercancel={() => drag = undefined} onclick={() => { selectedId = node.id; inspectorCollapsed = false; }} onkeydown={(event) => keyMove(event, node)}>
                <span class="node-topline"><span class="harness">{node.kind === 'router' ? $t('Decision') : harnessConfiguration(node.profile.harness).name}</span><span class="node-kind">{$t(node.kind === 'router' ? 'Router' : 'Agent')}</span></span>
                <strong>{node.profile.name}</strong>
                {#if node.kind === 'router'}<span class="node-model">{$t(node.router?.mode === 'agent' ? 'Agent decides' : 'Programmatic')}</span><span class="node-task">{node.router?.branches.length ?? 0} {$t('routes')}</span><div class="router-branches">{#each node.router?.branches ?? [] as branch}<span><i></i>{branch.label}</span>{/each}</div>
                {:else}<span class="node-model">{node.profile.model || $t('Model')}</span><span class="node-task">{node.task.trim() || $t('No task yet')}</span><small>{node.profile.reasoning ?? $t('Model default')}{node.profile.serviceTier === 'fast' ? $t(' · Fast') : ''}</small>{/if}
              </button>
              <button class="port port-in" class:connecting={connectionStart?.id === node.id && connectionStart.side === 'in'} data-port="in" data-node-id={node.id} aria-label={`${$t('Input connection')}: ${node.profile.name}`} disabled={safeMode || busy} onpointerdown={(event) => portDown(event, node.id, 'in')} onclick={(event) => portClick(event, node.id, 'in')} onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!event.repeat) event.currentTarget.click(); } }}></button>
              {#if node.kind === 'router'}{#each node.router?.branches ?? [] as branch, branchIndex}<button class="port port-route" class:connecting={connectionStart?.id === node.id && connectionStart.side === 'route' && connectionStart.branchId === branch.id} style:top={`${branchY(node, branch.id) - 19}px`} data-port="route" data-branch-id={branch.id} data-node-id={node.id} aria-label={`${$t('Route output')}: ${branch.label}`} disabled={safeMode || busy} onpointerdown={(event) => portDown(event, node.id, 'route', branch.id)} onclick={(event) => portClick(event, node.id, 'route', branch.id)} onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!event.repeat) event.currentTarget.click(); } }}><span>{branch.label}</span></button>{/each}{:else}<button class="port port-out" class:connecting={connectionStart?.id === node.id && connectionStart.side === 'out'} data-port="out" data-node-id={node.id} aria-label={`${$t('Output connection')}: ${node.profile.name}`} disabled={safeMode || busy} onpointerdown={(event) => portDown(event, node.id, 'out')} onclick={(event) => portClick(event, node.id, 'out')} onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!event.repeat) event.currentTarget.click(); } }}></button>{/if}
            </div>{/each}
      </GraphCanvas>
      <details class="connections" bind:open={connectionsOpen}><summary>{$t('Connections')} <span>{graph.edges.length}</span></summary>
        <div class="connection-form"><select aria-label={$t('From')} bind:value={from}><option value="">{$t('From')}</option>{#each graph.nodes as node}<option value={node.id}>{node.profile.name}</option>{/each}</select><select aria-label={$t('To')} bind:value={to}><option value="">{$t('To')}</option>{#each graph.nodes as node}<option value={node.id}>{node.profile.name}</option>{/each}</select><select aria-label={$t('Connections')} bind:value={kind}><option value="result">{$t('Result dependency')}</option><option value="send">{$t('Messaging')}</option><option value="observe">{$t('Observation')}</option><option value="spawn">{$t('Delegation')}</option></select><button onclick={connect} disabled={safeMode || busy || !from || !to}>{$t('Connect')}</button></div>
        <ul>{#each graph.edges as edge, index}<li class:selected-connection={selectedEdgeKey === edgeKey(edge)}><button class="connection-link" onclick={() => { selectedEdgeKey = edgeKey(edge); void focusNode(edge.to); }}><span>{nodeById.get(edge.from)?.profile.name} <b aria-hidden="true">→</b> {nodeById.get(edge.to)?.profile.name}</span><small>{$t(connectionLabel(edge.kind))}</small></button><button class="connection-remove" aria-label={`${$t('Remove')}: ${nodeById.get(edge.from)?.profile.name} → ${nodeById.get(edge.to)?.profile.name}, ${$t(connectionLabel(edge.kind))}`} disabled={safeMode || busy} onclick={() => removeEdge(index)}>×</button></li>{/each}</ul>
      </details>
    </div>
    {#if selected && !inspectorCollapsed}<aside aria-label={$t('Agent settings')}>
      <PanelResize label={$t('Resize agent settings')} storageKey="piui.graph.inspector.width" initial={320} minimum={260} edge="left" onresize={(width) => inspectorWidth = width} />
      <div class="inspector-heading"><div><h2>{selected.profile.name}</h2></div><button class="close-inspector" aria-label={$t('Hide inspector')} onclick={(event) => { event.currentTarget.closest('.graph-layout')?.querySelector<HTMLButtonElement>('.node.selected')?.focus(); inspectorCollapsed = true; }}>×</button></div>
        <label>{$t('Name')}<input value={selected.profile.name} oninput={(event) => updateProfile({ name: event.currentTarget.value })} disabled={safeMode || busy} /></label>
        {#if selected.kind === 'router'}<RouterSettings node={selected} nodes={graph.nodes} disabled={safeMode || busy} onchange={(change: Partial<GraphNode>) => updateRouterNode(selectedId, change)} onselectinput={(nodeId) => void selectRouterInput(nodeId)} />{/if}
        {#if selected.kind !== 'router' || selected.router?.mode === 'agent'}
        <label>{$t("Harness")}<select value={selected.profile.harness} onchange={(event) => { const harness = event.currentTarget.value as AgentProfile['harness']; updateProfile({ harness, model: '', modelProvider: undefined, permissionMode: harnessConfiguration(harness).defaultPermission, networkAccess: undefined, serviceTier: harnessConfiguration(harness).speed ? 'standard' : undefined, baseInstructions: undefined, reasoning: undefined }); }} disabled={safeMode || busy}><option value="codex">Codex</option><option value="prime-agent">Prime Agent</option><option value="pi">Pi</option><option value="hermes">Hermes</option><option value="claude-code">Claude Code</option></select></label>
        <label>{$t('Find model')}<input type="search" bind:value={modelQuery} /></label><label>{$t('Model')}<select aria-label={$t('Model')} value={JSON.stringify([selected.profile.modelProvider, selected.profile.model])} onchange={(event) => { const model = availableModels.find(entry => JSON.stringify([entry.provider, entry.id]) === event.currentTarget.value); if (model) updateProfile({ model: model.id, modelProvider: model.provider, reasoning: undefined, serviceTier: model.supportsFast && selected?.profile.serviceTier === 'fast' ? 'fast' : undefined }); }} disabled={safeMode || busy || modelsLoading}>
          {#if !nativeModel}<option disabled={!selected.profile.model} hidden={!selected.profile.model} value={JSON.stringify([selected.profile.modelProvider, selected.profile.model])}>{selected.profile.model || $t(modelsLoading ? 'Loading models…' : 'Select model')}</option>{/if}
          {#each availableModels.filter(model => model.id === selected?.profile.model || `${model.name} ${model.id} ${model.provider ?? ''}`.toLocaleLowerCase().includes(modelQuery.toLocaleLowerCase())) as model}<option value={JSON.stringify([model.provider, model.id])}>{model.name}{model.provider ? ` · ${model.provider}` : ''}</option>{/each}
        </select></label>
        <details class="inspector-section" bind:open={modelOptionsOpen}><summary>{$t('Model options')}</summary>{#if modelsError}<small class="model-error" role="alert">{$t(modelsError)}</small><button type="button" onclick={() => loadModels(selected.profile.harness, true)} disabled={modelsLoading}>{$t('Try again')}</button>{:else}<button type="button" onclick={() => loadModels(selected.profile.harness, true)} disabled={modelsLoading || safeMode || busy}>{$t(modelsLoading ? 'Loading models…' : 'Refresh models')}</button>{/if}<label>{$t('Reasoning')}<select aria-label={$t('Reasoning')} value={selected.profile.reasoning ?? ''} onchange={(event) => updateProfile({ reasoning: event.currentTarget.value || undefined })} disabled={safeMode || busy || !nativeModel?.thinkingLevels?.length}><option value="">{$t('Model default')}</option>{#if selected.profile.reasoning && !nativeModel?.thinkingLevels?.includes(selected.profile.reasoning)}<option value={selected.profile.reasoning}>{selected.profile.reasoning}</option>{/if}{#each nativeModel?.thinkingLevels ?? [] as level}<option value={level}>{$t(level)}</option>{/each}</select></label>{#if configuration?.speed}<label>{$t('Speed')}<select value={selected.profile.serviceTier ?? 'standard'} onchange={(event) => updateProfile({ serviceTier: event.currentTarget.value as 'standard' | 'fast' })} disabled={safeMode || busy}><option value="standard">{$t('Standard')}</option><option value="fast" disabled={!nativeModel?.supportsFast}>{$t("Fast")}</option></select></label>{#if selected.profile.serviceTier === 'fast'}<small>{$t('Fast may use additional credits.')}</small>{/if}{/if}</details>
        <div class="task-heading"><span>{$t('Task')}</span><button type="button" onclick={() => taskExpanded = true}>{$t('Expand editor')}</button></div>
        <textarea class="task-input" aria-label={$t('Task')} rows="9" placeholder={$t('Describe the goal, expected result and constraints…')} value={selected.task} oninput={(event) => updateNode(selectedId, { task: event.currentTarget.value })} disabled={safeMode || busy}></textarea>
        <details class="inspector-section"><summary>{$t('Additional instructions')}</summary><label>{$t('Input')}<textarea aria-label={$t('Input')} rows="5" placeholder={$t('What should upstream agents provide?')} value={selected.input ?? ''} oninput={(event) => updateNode(selectedId, { input: event.currentTarget.value })} disabled={safeMode || busy}></textarea></label><label>{$t('When to call')}<textarea aria-label={$t('When to call')} rows="3" value={selected.profile.whenToCall ?? ''} placeholder={$t('When is this agent useful?')} oninput={(event) => updateProfile({ whenToCall: event.currentTarget.value })} disabled={safeMode || busy}></textarea></label><label>{$t('Expected result')}<textarea aria-label={$t('Expected result')} rows="4" value={selected.profile.expectedResult ?? ''} placeholder={$t('What should this agent return?')} oninput={(event) => updateProfile({ expectedResult: event.currentTarget.value })} disabled={safeMode || busy}></textarea></label><label>{$t('Additional instructions')}<textarea rows="5" value={selected.profile.instructions} oninput={(event) => updateProfile({ instructions: event.currentTarget.value })} disabled={safeMode || busy}></textarea></label>{#if configuration?.basePrompt}<label class="check-row"><input type="checkbox" checked={selected.profile.baseInstructions === undefined} onchange={(event) => updateProfile({ baseInstructions: event.currentTarget.checked ? undefined : '' })} disabled={safeMode || busy} />{$t('Use base prompt')}</label>{/if}</details>
        {#if selected.kind !== 'router'}<details class="inspector-section" bind:open={flowOptionsOpen}><summary>{$t('Flow')}</summary><FlowSettings node={selected} nodes={graph.nodes} edges={graph.edges} disabled={safeMode || busy} onchange={(change) => updateNode(selectedId, change)} /></details>{/if}
        {#if selected.kind !== 'router' || selected.router?.mode === 'agent'}<ResultFields fields={selected.resultFields ?? []} disabled={safeMode || busy} onchange={(resultFields) => updateNode(selectedId, { resultFields })} />{/if}
        <label>{$t('Execution mode')}<select value={selected.executionMode ?? 'scheduled'} onchange={(event) => updateNode(selectedId, { executionMode: event.currentTarget.value as 'scheduled' | 'callable' })} disabled={safeMode || busy}><option value="scheduled">{$t('Run by dependencies')}</option><option value="callable">{$t('Only when called')}</option></select></label>
        <details class="inspector-section" bind:open={accessOptionsOpen}><summary>{$t('Access and tools')}<span>{selected.profile.permissionMode === 'native' ? $t('Native defaults') : $t(permissionLabels[selected.profile.permissionMode])}</span></summary><label>{$t('File access')}<select value={selected.profile.permissionMode} onchange={(event) => { const permissionMode = event.currentTarget.value as AgentProfile['permissionMode']; updateProfile({ permissionMode, ...(!['read-only', 'workspace-write'].includes(permissionMode) ? { networkAccess: undefined } : {}) }); }} disabled={safeMode || busy}>{#each configuration?.permissionModes ?? [] as mode}<option value={mode}>{$t(permissionLabels[mode])}</option>{/each}</select></label>{#if !configuration?.filesystemSandbox}<small>{$t('The adapter does not enforce a filesystem sandbox.')}</small>{/if}{#if configuration?.networkAccess}<label class="check-row"><input type="checkbox" checked={selected.profile.networkAccess ?? false} onchange={(event) => updateProfile({ networkAccess: event.currentTarget.checked || undefined })} disabled={safeMode || busy || !['read-only', 'workspace-write'].includes(selected.profile.permissionMode)} />{$t('Allow network access')}</label><small>{$t('Grants this Codex profile native outbound network access. It is disabled by default.')}</small>{/if}<ResourcePicker profile={selected.profile} items={resourceCatalogs[selected.profile.harness]?.items ?? []} loading={modelsLoading} disabled={safeMode || busy} onchange={updateProfile} />{#each resourceCatalogs[selected.profile.harness]?.warnings ?? [] as warning}<small role="status">{$t(warning)}</small>{/each}</details>
        <details class="inspector-section" bind:open={subagentsOpen}><summary>{$t('Subagents')}<span>{graph.edges.filter(edge => edge.from === selectedId && edge.kind === 'spawn').length}</span></summary><small>{$t('Choose which agents this profile may create. This controls workspace delegation, not native processes or OS access.')}</small>{#each graph.nodes as candidate (candidate.id)}<label class="check-row"><input type="checkbox" checked={graph.edges.some(edge => edge.from === selectedId && edge.to === candidate.id && edge.kind === 'spawn')} disabled={safeMode || busy} onchange={(event) => { graph = { ...graph, edges: event.currentTarget.checked ? [...graph.edges, { from: selectedId, to: candidate.id, kind: 'spawn' }] : graph.edges.filter(edge => !(edge.from === selectedId && edge.to === candidate.id && edge.kind === 'spawn')) }; }} />{candidate.profile.name}</label>{/each}</details>
        {/if}
<button onclick={copySelected} disabled={safeMode || busy}>{$t('Duplicate agent')}</button><small>{$t('Adds an independent copy without connections or delegation permissions.')}</small>
<button class="danger" onclick={remove} disabled={safeMode || busy}>{$t(selected.kind === 'router' ? 'Remove router' : 'Remove agent')}</button>
      </aside>{/if}
  </div>
</section>

{#if pendingNavigation}<div class="task-backdrop"><div class="navigation-dialog" role="dialog" aria-modal="true" aria-label={$t('Unsaved changes')} tabindex="-1" use:modalFocus={() => pendingNavigation = undefined}><h2>{$t('Unsaved changes')}</h2><p>{$t('Save this system before continuing?')}</p>{#each [...errors,...validationIssues.map(issue=>issue.message)] as error}<p role="alert">{$t(error)}</p>{/each}<button disabled={busy} onclick={() => continueNavigation(true)}>{$t('Save and continue')}</button><button disabled={busy} onclick={() => continueNavigation(false)}>{$t('Discard changes')}</button><button disabled={busy} onclick={() => pendingNavigation = undefined}>{$t('Keep editing')}</button></div></div>{/if}
{#if taskExpanded && selected}
  <div class="task-backdrop">
    <div class="task-editor" onfocusin={() => editingField = true} onfocusout={() => { history.record(graph); history = history; editingField = false; }} role="dialog" aria-modal="true" aria-labelledby="task-editor-title" tabindex="-1" use:modalFocus={() => taskExpanded = false}>
      <header><div><small>{selected.profile.name}</small><h2 id="task-editor-title">{$t('Task')}</h2></div><button type="button" onclick={() => taskExpanded = false}>{$t('Done')}</button></header>
      <textarea aria-label={$t('Task')} value={selected.task} oninput={(event) => updateNode(selectedId, { task: event.currentTarget.value })} disabled={safeMode || busy} placeholder={$t('Describe the goal, expected result and constraints…')}></textarea>
    </div>
  </div>
{/if}

<style>
  .navigation-dialog { background:var(--piui-bg-raised); padding:24px; border:1px solid var(--piui-border); border-radius:var(--piui-radius-md); max-width:100%; }
  .document-tools { display:flex; flex-wrap:wrap; gap:var(--piui-space-2); padding:var(--piui-space-2); position:relative; }
  .document-tools details { position:relative; } .document-tools details p { max-width:32ch; }
  .document-tools input { flex:1; min-width:0; } .node-results { display:flex; flex-wrap:wrap; width:100%; gap:4px; }
  .connection-options { position:relative; } .connection-options summary { padding:6px 9px; } .connection-options > div { position:absolute; top:100%; left:0; display:grid; gap:8px; padding:8px; z-index:10; border:1px solid var(--piui-border); background:var(--piui-bg-raised); }
  .open-system { position:relative; } .open-system summary { cursor:pointer; padding:5px 9px; } .open-system > div { position:absolute; right:0; top:100%; z-index:10; display:grid; gap:8px; padding:8px; background:var(--piui-bg-raised); border:1px solid var(--piui-border); }
  .system-search { width:10em; min-width:0; }
  .inspector-section { display:grid; gap:10px; border-top:1px solid var(--piui-border-subtle); padding-top:12px; }
  .inspector-section summary { cursor:pointer; color:var(--piui-text); font-size:12px; font-weight:600; }
  .inspector-section summary span { margin-left:6px; color:var(--piui-text-faint); font-size:11px; font-weight:400; }
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
  input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible,summary:focus-visible { outline:2px solid var(--piui-focus); outline-offset:2px; }
  .system-name { font-size:15px; font-weight:650; letter-spacing:-.01em; border-color:transparent; background:transparent; padding:1px 3px; flex:1; min-width:180px; } .system-name:focus { background:var(--piui-bg); border-color:var(--piui-border); }
  .open-system select { max-width:180px; } .save-state { color:var(--piui-text-faint); font-size:11px; padding-left:3px; } .toolbar-secondary { background:transparent; border-color:var(--piui-border-subtle); } .primary { background:var(--piui-action); color:var(--piui-action-ink); border-color:transparent; font-weight:650; } .primary:hover:not(:disabled) { background:var(--piui-action); filter:brightness(1.1); } .run-action span { margin-left:3px; font-size:14px; }
  .graph-layout { flex:1; display:grid; grid-template-columns:minmax(0,1fr); min-height:0; } .graph-layout.has-selection { grid-template-columns:minmax(0,1fr) var(--graph-inspector-width); }
  .canvas-column { min-width:0; min-height:0; display:flex; flex-direction:column; }
  .canvas-tools { display:flex; align-items:center; gap:6px; padding:8px 14px; min-height:48px; border-bottom:1px solid var(--piui-border-subtle); background:var(--piui-surface-1); flex-wrap:wrap; font-size:12px; }
  .node-palette { display:flex; align-items:center; gap:2px; padding:2px; border:1px solid var(--piui-border-subtle); border-radius:var(--piui-radius-sm); background:var(--piui-bg); }
  .node-palette button { display:flex; align-items:center; gap:5px; border:0; border-radius:5px; color:var(--piui-text-muted); padding:5px 8px; background:transparent; }
  .node-palette button:hover:not(:disabled),.node-palette button.palette-selected { color:var(--piui-text); background:var(--piui-surface-2); box-shadow:inset 0 0 0 1px var(--piui-border); }
  .node-palette .palette-agent.palette-selected { color:var(--piui-action); } .node-palette .palette-router.palette-selected { color:var(--piui-accent); }
  .palette-glyph { font-size:11px; line-height:1; } .palette-router .palette-glyph { font-size:15px; }
  .canvas-tools button,.canvas-tools select { border-color:transparent; background:transparent; } .canvas-tools button:hover:not(:disabled),.canvas-tools select:hover:not(:disabled) { background:var(--piui-surface-2); } .canvas-menu,.edge-help { position:relative; }.canvas-menu summary,.edge-help summary { cursor:pointer; list-style:none; padding:5px 8px; border-radius:var(--piui-radius-sm); color:var(--piui-text-muted); }.canvas-menu summary::-webkit-details-marker,.edge-help summary::-webkit-details-marker { display:none; }.canvas-menu[open] summary,.edge-help[open] summary { background:var(--piui-surface-2); color:var(--piui-text); }.canvas-menu select { position:absolute; z-index:4; top:calc(100% + 4px); left:0; min-width:150px; padding:6px 9px; border:1px solid var(--piui-border); border-radius:var(--piui-radius-sm); background:var(--piui-bg-raised); }.tool-primary { color:var(--piui-text); border-color:var(--piui-border) !important; background:var(--piui-bg-raised) !important; font-weight:600; } .tool-icon { color:var(--piui-accent); font-size:16px; line-height:0; } .spacer { flex:1; min-width:12px; }
  .edge-help .edge-legend { position:absolute; z-index:4; top:calc(100% + 4px); right:0; display:grid; gap:8px; min-width:150px; padding:9px; border:1px solid var(--piui-border); border-radius:var(--piui-radius-sm); background:var(--piui-bg-raised); }.edge-legend { color:var(--piui-text-faint); font-size:10px; white-space:nowrap; } .edge-legend span { display:flex; align-items:center; gap:4px; } .legend-line { width:15px; height:0; border-top:2px solid var(--piui-text-muted); } .legend-line.message-line { border-top-style:dashed; } .legend-line.observe-line { border-top-style:dotted; border-color:var(--piui-accent); }
  .inspector-reopen { color:var(--piui-accent); }

  .placement-hint { position:sticky; top:12px; z-index:3; width:max-content; max-width:calc(100% - 28px); margin:12px auto -42px; padding:7px 10px; border:1px solid var(--piui-border-strong); border-radius:999px; color:var(--piui-text); background:color-mix(in srgb,var(--piui-bg-raised) 92%,transparent); box-shadow:0 8px 20px color-mix(in srgb,var(--piui-bg) 40%,transparent); font-size:11px; }
  .placement-hint button { min-height:0; margin-left:7px; padding:2px 6px; border:0; background:transparent; color:var(--piui-accent); }
  svg { position:absolute; pointer-events:none; } svg > path { pointer-events:stroke; fill:none; stroke:var(--piui-text-faint); stroke-width:1.8; transition:stroke .14s ease,opacity .14s ease,stroke-width .14s ease; } svg > path.secondary-edge { stroke:var(--piui-text-muted); stroke-dasharray:5 5; } svg > path.spawn-edge { stroke:var(--piui-accent); } svg > path.observe-edge { stroke-dasharray:2 6; } svg > path.route-edge { stroke:var(--piui-accent); stroke-dasharray:3 4; } svg > path.muted-edge { opacity:.18; } svg > path.related-edge { stroke-width:2.3; } svg > path.selected-edge { stroke:var(--piui-accent); stroke-width:2.8; opacity:1; }
  svg > path.edge-hit, svg > path.edge-hit:hover { stroke:transparent; stroke-width:var(--piui-space-4); pointer-events:stroke; }
  .node-shell { position:absolute; width:232px; }
  .node-shell .node { min-height:inherit; }
  .node { position:relative; width:232px; min-height:124px; box-sizing:border-box; display:grid; gap:5px; align-content:start; text-align:left; padding:13px 16px; touch-action:none; user-select:none; background:var(--piui-bg-raised); border-radius:12px; box-shadow:0 8px 22px color-mix(in srgb,var(--piui-bg) 70%,transparent); }
  .node:hover { border-color:var(--piui-border-strong); transform:translateY(-1px); } .node.selected { border-color:var(--piui-action); background:color-mix(in srgb,var(--piui-bg-raised) 88%,var(--piui-accent-soft)); box-shadow:0 0 0 1px var(--piui-action),0 10px 26px color-mix(in srgb,var(--piui-action) 18%,transparent); } .node.node-related { border-color:color-mix(in srgb,var(--piui-accent) 55%,var(--piui-border)); }
  .router-node { min-height:152px; border-color:color-mix(in srgb,var(--piui-accent) 42%,var(--piui-border)); background:color-mix(in srgb,var(--piui-bg-raised) 94%,var(--piui-accent-soft)); }
  .router-node .harness { color:var(--piui-accent); } .router-node .node-kind { color:var(--piui-accent) !important; }
  .router-branches { display:grid; gap:3px; margin-top:2px; padding-top:5px; border-top:1px solid var(--piui-border-subtle); }
  .router-branches span { display:flex; align-items:center; gap:5px; color:var(--piui-text) !important; font-size:10px !important; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .router-branches i { width:6px; height:6px; flex:0 0 auto; border:1px solid var(--piui-accent); border-radius:2px; background:var(--piui-accent-soft); }
  .node-topline { display:flex; justify-content:space-between; align-items:center; gap:8px; } .node strong { font-size:14px; font-weight:650; letter-spacing:-.01em; overflow-wrap:anywhere; } .node span,.node small { color:var(--piui-text-muted); overflow-wrap:anywhere; font-size:11px; } .node .harness { color:var(--piui-accent); font-size:10px; letter-spacing:.04em; text-transform:uppercase; } .node-kind { color:var(--piui-text-faint) !important; font-size:9px !important; text-transform:uppercase; letter-spacing:.06em; } .node-model { color:var(--piui-text) !important; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .node-task { display:-webkit-box; line-clamp:2; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; min-height:28px; line-height:1.35; color:var(--piui-text-muted) !important; }
  .port { position:absolute; top:47px; width:38px; height:38px; min-height:38px; padding:0; border:0; background:transparent; border-radius:50%; touch-action:none; } .port::before { content:''; position:absolute; top:18px; width:13px; border-top:1px solid var(--piui-border-strong); } .port::after { content:''; position:absolute; top:13px; width:11px; height:11px; border:2px solid var(--piui-border-strong); border-radius:50%; background:var(--piui-bg); } .port-in { left:-25px; } .port-in::before { right:7px; } .port-in::after { right:0; } .port-out { right:-25px; } .port-out::before { left:7px; } .port-out::after { left:0; }
  .port-route { right:-25px; width:76px; text-align:left; } .port-route::before { left:7px; border-color:var(--piui-accent); } .port-route::after { left:0; border-color:var(--piui-accent); border-radius:3px; } .port-route span { position:absolute; left:22px; top:11px; max-width:53px; overflow:hidden; color:var(--piui-accent); font-size:9px; text-overflow:ellipsis; white-space:nowrap; }
  .port-route:hover span,.port-route.connecting span,.port-route:focus-visible span { color:var(--piui-text); }
  .port:hover::after,.port.connecting::after,.port:focus-visible::after { background:var(--piui-accent); border-color:var(--piui-accent); } svg > path:hover { stroke:var(--piui-accent); stroke-width:2.8; opacity:1; } svg > path.connection-preview { stroke:var(--piui-accent); stroke-dasharray:5 5; }
  .connection-status { display:flex; align-items:center; gap:8px; padding:7px 14px; font-size:12px; color:var(--piui-text-muted); background:var(--piui-accent-soft); border-bottom:1px solid var(--piui-border-subtle); }
  aside { position:relative; min-width:0; min-height:0; border-left:1px solid var(--piui-border-subtle); padding:18px; display:flex; flex-direction:column; gap:12px; overflow:auto; background:var(--piui-bg-raised); } .inspector-heading { display:flex; align-items:center; justify-content:space-between; padding-bottom:12px; border-bottom:1px solid var(--piui-border-subtle); } aside h2 { font-size:15px; margin:0; font-weight:650; overflow-wrap:anywhere; } .close-inspector { border:0; padding:0; width:28px; min-height:28px; font-size:18px; color:var(--piui-text-muted); background:transparent; }
  aside label { display:grid; gap:5px; font-size:12px; color:var(--piui-text-muted); } aside label input,aside label select,textarea { background:var(--piui-bg); } aside small { color:var(--piui-text-faint); font-size:11px; line-height:1.45; } textarea { min-height:78px; resize:vertical; } .danger { color:var(--piui-danger-text); background:transparent; border-color:transparent; margin-top:auto; text-align:left; }
  .connections { border-top:1px solid var(--piui-border-subtle); padding:10px 14px; font-size:12px; background:var(--piui-bg-raised); } summary { cursor:pointer; } summary span { color:var(--piui-text-faint); margin-left:8px; } .connection-form { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; } .connection-form select { flex:1; } ul { list-style:none; margin:7px 0 0; padding:0; max-height:180px; overflow:auto; } li { display:flex; gap:6px; align-items:center; padding:2px 0; border-radius:var(--piui-radius-sm); } li.selected-connection { background:var(--piui-accent-soft); } .connection-link { flex:1; display:grid; gap:2px; min-width:0; border:0; background:transparent; text-align:left; padding:6px 8px; } .connection-link span { overflow-wrap:anywhere; } .connection-link b { color:var(--piui-accent); font-weight:500; } li small { color:var(--piui-text-faint); } .connection-remove { flex:0 0 auto; border:0; background:transparent; color:var(--piui-text-faint); }
  .empty { position:absolute; top:80px; left:10%; right:10%; z-index:1; text-align:center; padding:30px; border:1px dashed var(--piui-border); border-radius:var(--piui-radius-lg); background:color-mix(in srgb,var(--piui-bg-raised) 70%,transparent); } .empty h2 { font-size:20px; font-weight:600; margin:0 0 8px; } .empty p { font-size:13px; color:var(--piui-text-muted); margin-bottom:20px; } .notice,.errors { padding:8px 14px; font-size:12px; } .errors { color:var(--piui-danger-text); background:var(--piui-danger-surface); } .errors p { margin:4px 0; }
  @media(max-width:1100px) { .edge-legend { display:none; } .toolbar { align-items:flex-start; flex-direction:column; } .document-actions { width:100%; justify-content:flex-start; } }
  @media(max-width:900px) { .open-system select { max-width:140px; } }
  @media(max-width:700px) { .graph-layout.has-selection { grid-template-columns:1fr; grid-template-rows:minmax(160px,1fr) minmax(0,1fr); } aside { border-left:0; border-top:1px solid var(--piui-border-subtle); } .canvas-tools { align-items:flex-start; }  }
</style>
