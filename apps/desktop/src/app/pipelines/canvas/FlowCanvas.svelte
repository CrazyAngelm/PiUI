<script lang="ts">
  import '@xyflow/svelte/dist/style.css';
  import './nodeCard.css';
  import { Background, BackgroundVariant, MarkerType, MiniMap, Panel, SvelteFlow, type Connection } from '@xyflow/svelte';
  import { untrack } from 'svelte';
  import Minus from '@lucide/svelte/icons/minus';
  import Plus from '@lucide/svelte/icons/plus';
  import Maximize from '@lucide/svelte/icons/maximize';
  import LayoutGrid from '@lucide/svelte/icons/layout-grid';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import Redo2 from '@lucide/svelte/icons/redo-2';
  import Eye from '@lucide/svelte/icons/eye';
  import EyeOff from '@lucide/svelte/icons/eye-off';
  import { useTranslation } from '../../../features/locale/context';
  const t = useTranslation();
  import type { ConnectionKind } from '../../../features/orchestration/agentGraph';
  import { IconButton, Segmented, toasts } from '../../../lib/ui';
  import { edgeKey } from '../../../features/orchestration/graphCanvasEditing';
  import type { GraphCanvasController } from './graphCanvasController';
  import AgentNodeCard, { type AgentFlowNode } from './AgentNodeCard.svelte';
  import RouterNodeCard, { type RouterFlowNode } from './RouterNodeCard.svelte';
  import PiuiEdge, { type PiuiFlowEdge } from './PiuiEdge.svelte';
  import StartNodeCard, { type StartFlowNode } from './StartNodeCard.svelte';
  import OutputNodeCard, { type OutputFlowNode } from './OutputNodeCard.svelte';
  import { presentationNodeIds, presentationEdgeId, isPresentationEdge as blockEdge } from './graphRenderIdentity';
  import { RUN_INPUT_ISSUES } from '../../../host-api/runInputs';
  import { SUBPIPELINE_ISSUES } from '../../../host-api/subpipelines';

  const INPUT_ISSUES: ReadonlySet<string> = new Set(
    [RUN_INPUT_ISSUES.count, RUN_INPUT_ISSUES.names, RUN_INPUT_ISSUES.labels, RUN_INPUT_ISSUES.options, RUN_INPUT_ISSUES.defaults],
  );
  import FlowBridge, { type FlowApi } from './FlowBridge.svelte';
  import { connectionLabel } from './connectionLabel';
  import { outputConnections } from './outputConnections';
  import SparkConnectionLine from './SparkConnectionLine.svelte';
  import { createWireAssigner } from './wireHue';

  interface Props {
    editor: GraphCanvasController;
    /** Called when the user double-clicks empty canvas (flow coordinates). */
    onAddRequest: (position: { x: number; y: number }) => void;
    onready: (api: FlowApi) => void;
  }
  let { editor, onAddRequest, onready }: Props = $props();

  type FlowNode = AgentFlowNode | RouterFlowNode | StartFlowNode | OutputFlowNode;
  const nodeTypes = { agent: AgentNodeCard, router: RouterNodeCard, start: StartNodeCard, output: OutputNodeCard };
  /** Presentation-only blocks: never deleted, moved or saved. */
  const blocks = $derived(presentationNodeIds(editor.graph.nodes.map(node => node.id)));
  const BLOCK_IDS: ReadonlySet<string> = $derived(new Set([blocks.start, blocks.output]));
  const edgeTypes = { piui: PiuiEdge };
  const COLLABORATION: ReadonlySet<ConnectionKind> = new Set(['send', 'observe', 'spawn']);
  const markerColor: Record<ConnectionKind, string> = {
    result: 'var(--piui-text-disabled)',
    route: 'var(--piui-accent)',
    send: 'var(--piui-info)',
    observe: 'var(--piui-text-muted)',
    spawn: 'var(--piui-warning)',
  };

  let container = $state<HTMLDivElement | null>(null);
  let api = $state.raw<FlowApi | undefined>();
  let nodes = $state.raw<FlowNode[]>([]);
  let edges = $state.raw<PiuiFlowEdge[]>([]);
  let colorMode = $state<'dark' | 'light' | 'system'>('system');
  /** The connection the user has just made: plays the strike animation once. */
  let fresh = $state.raw<{ edges: ReadonlySet<string>; target: string; source: string } | undefined>();
  let freshTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => clearTimeout(freshTimer));
  const WIRED: ReadonlySet<ConnectionKind> = new Set(['result', 'route']);
  // A step keeps its wire hue while it exists: deleting another step never recolors it.
  const assignWires = createWireAssigner();

  $effect(() => {
    const root = container?.closest<HTMLElement>('[data-nano-ui]') ?? document.documentElement;
    const read = () => {
      const theme = root.dataset.theme;
      colorMode = theme === 'dark' || theme === 'light' ? theme : 'system';
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  });

  function sync(): void {
    const graph = editor.graph;
    const readOnly = editor.readOnly;
    const output = outputConnections(graph);
    // Accessible names of nodes and connections (Svelte Flow defaults use ids).
    const names = new Map(graph.nodes.map((node) => [
      node.id,
      node.profile.name ||
        $t(node.kind === 'router' ? 'Router' : node.executor?.type === 'script' ? 'Untitled script' : node.executor?.type === 'pipeline' ? 'Untitled sub-pipeline' : 'Untitled agent'),
    ]));
    // New steps take the least used hue; existing steps keep theirs.
    const wires = assignWires(graph.nodes.map((node) => node.id));
    const wireOf = (id: string): string => wires.get(id) ?? 'var(--piui-wire-idle)';
    const graphNodes = graph.nodes.map((node) => ({
      id: node.id,
      type: node.kind === 'router' ? 'router' : 'agent',
      ariaLabel: names.get(node.id),
      position: { x: node.x, y: node.y },
      data: {
        node,
        executionLocation: editor.executionLocation ?? 'this-computer',
        problems: editor.nodeProblems(node.id).length,
        readOnly,
        wire: wireOf(node.id),
        wiredOut: output.sources.has(node.id) || (node.kind !== 'router' && graph.edges.some((edge) => edge.from === node.id && WIRED.has(edge.kind))),
        wiredBranches: graph.edges.filter((edge) => edge.from === node.id && edge.kind === 'route').map((edge) => edge.branchId ?? ''),
        inputs: [...new Set(graph.edges.filter((edge) => edge.to === node.id && WIRED.has(edge.kind)).map((edge) => edge.from))].map((from) => ({
          id: from,
          name: names.get(from) ?? '',
          wire: wireOf(from),
        })),
        flash: fresh?.target === node.id ? { from: fresh.source, wire: wireOf(fresh.source) } : undefined,
        // v6.7: a sub-pipeline card shows its child's inputs and outputs and opens it.
        ...(node.executor?.type === 'pipeline'
          ? { child: editor.subpipelines.get(node.executor.launchCommandId), onOpenPipeline: (id: string) => editor.open(id) }
          : {}),
      },
      selected: editor.selectedId === node.id,
      draggable: !readOnly,
      deletable: !readOnly,
    })) as FlowNode[];
    // The start node is presentation only: it shows the run inputs and which
    // agents begin the run. It never becomes part of the saved graph.
    const entries = graph.nodes.filter(
      (node) => node.executionMode !== 'callable' && !graph.edges.some((edge) => edge.to === node.id && (edge.kind === 'result' || edge.kind === 'route')),
    );
    const startEdges: PiuiFlowEdge[] = [];
    const startNodes: StartFlowNode[] = [];
    if (entries.length) {
      const x = Math.min(...entries.map((node) => node.x)) - 290;
      const y = entries.reduce((sum, node) => sum + node.y, 0) / entries.length + 8;
      const inputProblems = editor.issues.filter((issue) => INPUT_ISSUES.has(issue.message)).length;
      startNodes.push(
        {
          id: blocks.start,
          type: 'start',
          ariaLabel: $t('Start'),
          position: { x, y },
          data: { inputs: graph.inputs ?? [], problems: inputProblems },
          selected: editor.selectedBlock === 'start',
          draggable: false,
          deletable: false,
          connectable: false,
        } as StartFlowNode,
      );
      for (const entry of entries) {
        startEdges.push({
          id: presentationEdgeId('start', entry.id),
          type: 'piui',
          source: blocks.start,
          target: entry.id,
          ariaLabel: connectionLabel($t, 'start', $t('Start'), names.get(entry.id) ?? ''),
          sourceHandle: 'out',
          targetHandle: 'in',
          data: { kind: 'result' },
          class: 'start-edge',
          selectable: false,
          deletable: false,
          markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: 'var(--piui-success)' },
        });
      }
    }
    // With no declared fields, Output marks the end of each scheduled branch.
    // Like Start, these links are presentation only, never saved dependencies.
    const outputNodes: OutputFlowNode[] = [];
    const outputEdges: PiuiFlowEdge[] = [];
    if (graph.nodes.length) {
      const exits = graph.nodes.filter(
        (node) => node.executionMode !== 'callable' && !graph.edges.some((edge) => edge.from === node.id && (edge.kind === 'result' || edge.kind === 'route')),
      );
      const placed = exits.length ? exits : graph.nodes;
      const x = Math.max(...placed.map((node) => node.x)) + 300;
      const y = placed.reduce((sum, node) => sum + node.y, 0) / placed.length + 8;
      const outputs = graph.outputs ?? [];
      outputNodes.push({
        id: blocks.output,
        type: 'output',
        ariaLabel: $t('Output'),
        position: { x, y },
        data: { outputs, wired: output.sources.size > 0, readOnly, problems: editor.issues.filter((issue) => issue.message === SUBPIPELINE_ISSUES.outputs).length },
        selected: editor.selectedBlock === 'output',
        draggable: false,
        deletable: false,
        connectable: !readOnly,
      } as OutputFlowNode);
      for (const source of output.sources) {
        outputEdges.push({
          id: presentationEdgeId('output', source),
          type: 'piui',
          source,
          target: blocks.output,
          ariaLabel: connectionLabel($t, output.implicit ? 'completion' : 'result', names.get(source) ?? '', $t('Output')),
          sourceHandle: 'out',
          targetHandle: 'in',
          data: { kind: 'result' },
          class: 'output-edge',
          selectable: false,
          deletable: false,
          markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: 'var(--piui-decoration-secondary)' },
        });
      }
    }
    // Assign once: reading `nodes` here would make this effect depend on itself.
    nodes = [...startNodes, ...graphNodes, ...outputNodes];
    edges = [...startEdges, ...outputEdges, ...graph.edges.map((edge): PiuiFlowEdge => {
      const router = edge.kind === 'route' ? graph.nodes.find((node) => node.id === edge.from) : undefined;
      const label = edge.kind === 'route' ? router?.router?.branches.find((branch) => branch.id === edge.branchId)?.label : undefined;
      const wire = WIRED.has(edge.kind) ? wireOf(edge.from) : undefined;
      return {
        id: edgeKey(edge),
        type: 'piui',
        source: edge.from,
        target: edge.to,
        ariaLabel: connectionLabel($t, edge.kind, names.get(edge.from) ?? '', names.get(edge.to) ?? ''),
        sourceHandle: edge.kind === 'route' ? `branch:${edge.branchId ?? ''}` : 'out',
        targetHandle: 'in',
        data: { kind: edge.kind, label, wire, fresh: fresh?.edges.has(edgeKey(edge)) ?? false },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: wire ?? markerColor[edge.kind] },
        hidden: COLLABORATION.has(edge.kind) && !editor.showCollaboration,
        selected: editor.selectedEdge === edgeKey(edge),
        deletable: !readOnly,
      };
    })];
  }

  $effect(() => {
    // Re-project whenever the document, selection, problems or mode change.
    void editor.graph;
    void editor.selectedId;
    void editor.selectedBlock;
    void editor.selectedEdge;
    void editor.issues;
    void editor.preflight;
    void editor.showCollaboration;
    void editor.busy;
    void editor.readOnly;
    void fresh;
    sync();
  });

  /** Rendered card heights (flow units) so Arrange never lets a taller card run into the next. */
  function cardHeights(): Map<string, number> {
    const heights = new Map<string, number>();
    for (const element of container?.querySelectorAll<HTMLElement>('.svelte-flow__node[data-id]') ?? []) {
      const id = element.dataset.id;
      if (id && !BLOCK_IDS.has(id) && element.offsetHeight > 0) heights.set(id, element.offsetHeight);
    }
    return heights;
  }

  function beforeConnect(connection: Connection): false {
    if (connection.target === blocks.output) {
      const error = editor.connectOutput(connection.source);
      if (error) toasts.error($t('Cannot connect'), $t(error));
      else if (!editor.readOnly) {
        editor.selectedId = '';
        editor.selectedBlock = 'output';
        editor.selectedEdge = '';
      }
      sync();
      return false;
    }
    const before = new Set(editor.graph.edges.map(edgeKey));
    const error = editor.connect(connection.source, connection.target, connection.sourceHandle);
    if (error) toasts.error($t('Cannot connect'), $t(error));
    const added = editor.graph.edges.filter((edge) => !before.has(edgeKey(edge)));
    if (added.length) {
      clearTimeout(freshTimer);
      fresh = { edges: new Set(added.map(edgeKey)), target: added[0].to, source: added[0].from };
      freshTimer = setTimeout(() => (fresh = undefined), 1400);
    } else {
      sync();
    }
    return false;
  }

  function selectNode(node: FlowNode): void {
    const block = node.type === 'start' ? 'start' : node.type === 'output' ? 'output' : undefined;
    if (block) {
      if (editor.selectedBlock !== block) { editor.selectedId = ''; editor.selectedBlock = block; }
    } else if (editor.selectedId !== node.id || editor.selectedBlock !== undefined) editor.selectedId = node.id;
    if (editor.selectedEdge) editor.selectedEdge = '';
  }

  const kindOptions = $derived([
    { value: 'result' as const, label: $t('Result'), title: $t('The next agent starts after this one and receives its result') },
    { value: 'send' as const, label: $t('Messages'), title: $t('The agent may send messages to the other one') },
    { value: 'observe' as const, label: $t('Observe'), title: $t('The agent may read the other one’s progress and wait for its result') },
    { value: 'spawn' as const, label: $t('Delegate'), title: $t('The agent may start new instances of the other one') },
  ]);
</script>

<div class="canvas" bind:this={container}>
  <SvelteFlow
    bind:nodes
    bind:edges
    {nodeTypes}
    {edgeTypes}
    {colorMode}
    fitView
    fitViewOptions={{ padding: 0.25, maxZoom: 1.1 }}
    minZoom={0.2}
    maxZoom={1.8}
    deleteKey={['Delete', 'Backspace']}
    snapGrid={[8, 8]}
    connectionRadius={36}
    connectionLineComponent={SparkConnectionLine}
    proOptions={{ hideAttribution: true }}
    class="piui-flow"
    onbeforeconnect={beforeConnect}
    onbeforedelete={async ({ nodes: removedNodes, edges: removedEdges }) => {
      editor.removeSelection(
        removedNodes.map((node) => node.id).filter((id) => !BLOCK_IDS.has(id)),
        removedEdges.map((edge) => edge.id).filter((id) => !blockEdge(id)),
      );
      return false;
    }}
    onnodedragstop={({ nodes: moved }) =>
      editor.movedNodes(moved.filter((node) => !BLOCK_IDS.has(node.id)).map((node) => ({ id: node.id, x: node.position.x, y: node.position.y })))}
    onnodeclick={({ node }) => selectNode(node)}
    onselectionchange={({ nodes: selectedNodes, edges: selectedEdges }) => untrack(() => {
      // Svelte Flow invokes this callback from its selection effect. Reading the
      // editor here must not subscribe that effect to programmatic selection:
      // it could replay the old canvas selection before sync projects the new one.
      // A single keyboard-selected node opens the inspector. Rectangle/multi
      // selection stays owned by Svelte Flow for bulk delete and movement.
      if (selectedNodes.length === 1) selectNode(selectedNodes[0]);
      else if (selectedNodes.length === 0) {
        const edge = selectedEdges.find(item => !blockEdge(item.id));
        if (edge && editor.selectedEdge !== edge.id) { editor.selectedId = ''; editor.selectedEdge = edge.id; }
      }
    })}
    onedgeclick={({ edge }) => {
      if (blockEdge(edge.id)) return;
      editor.selectedEdge = edge.id;
      editor.selectedId = '';
    }}
    onpaneclick={({ event }) => {
      editor.selectedId = '';
      editor.selectedEdge = '';
      if (event.detail === 2 && !editor.readOnly) onAddRequest({ x: event.clientX, y: event.clientY });
    }}
  >
    <FlowBridge
      {container}
      onready={(next) => {
        api = next;
        onready(next);
      }}
    />
    <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} />
    <MiniMap
      position="bottom-right"
      pannable
      zoomable
      width={168}
      height={112}
      nodeColor="var(--piui-surface-3)"
      maskColor="color-mix(in srgb, var(--piui-bg) 70%, transparent)"
    />
    <Panel position="top-left">
      <div class="floating connect" role="group" aria-label={$t('New connections mean')}>
        <span class="floating__label">{$t('Connect as')}</span>
        <Segmented size="sm" label={$t('New connections mean')} bind:value={editor.connectKind} options={kindOptions} />
        <IconButton
          size="sm"
          label={editor.showCollaboration ? $t('Hide collaboration links') : $t('Show collaboration links')}
          active={!editor.showCollaboration}
          onclick={() => (editor.showCollaboration = !editor.showCollaboration)}
        >
          {#if editor.showCollaboration}<Eye />{:else}<EyeOff />{/if}
        </IconButton>
      </div>
    </Panel>
    <Panel position="bottom-left">
      <div class="floating" role="toolbar" aria-label={$t('Canvas controls')}>
        <IconButton size="sm" label={$t('Undo')} shortcut="Mod+Z" disabled={!editor.canUndo || editor.readOnly} onclick={() => editor.undo()}><Undo2 /></IconButton>
        <IconButton size="sm" label={$t('Redo')} shortcut="Mod+Shift+Z" disabled={!editor.canRedo || editor.readOnly} onclick={() => editor.redo()}><Redo2 /></IconButton>
        <span class="divider"></span>
        <IconButton size="sm" label={$t('Zoom out')} onclick={() => api?.zoomOut()}><Minus /></IconButton>
        <IconButton size="sm" label={$t('Zoom in')} onclick={() => api?.zoomIn()}><Plus /></IconButton>
        <IconButton size="sm" label={$t('Fit to screen')} onclick={() => api?.fitView()}><Maximize /></IconButton>
        <IconButton
          size="sm"
          label={$t('Arrange automatically')}
          disabled={editor.readOnly || editor.graph.nodes.length === 0}
          onclick={() => {
            editor.arrange(cardHeights());
            setTimeout(() => api?.fitView(), 30);
          }}><LayoutGrid /></IconButton
        >
      </div>
    </Panel>
  </SvelteFlow>
</div>

<style>
  .canvas {
    position: relative;
    width: 100%;
    height: 100%;
  }
  .canvas :global(.piui-flow) {
    --xy-background-color: var(--piui-bg);
    --xy-background-pattern-dots-color-default: color-mix(in srgb, var(--piui-text-muted) 20%, transparent);
    --xy-minimap-background-color-default: var(--piui-bg-raised);
    --xy-minimap-mask-background-color-default: color-mix(in srgb, var(--piui-bg) 72%, transparent);
    --xy-edge-stroke-default: var(--piui-text-disabled);
    --xy-selection-background-color-default: color-mix(in srgb, var(--piui-accent) 10%, transparent);
    --xy-selection-border-default: 1px dashed var(--piui-accent);
    --xy-node-border-radius-default: 12px;
    background: var(--piui-bg);
  }
  .canvas :global(.svelte-flow__node) {
    border: 0;
    background: transparent;
    box-shadow: none;
    padding: 0;
  }
  .canvas :global(.svelte-flow__minimap) {
    overflow: hidden;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
  }
  .canvas :global(.port) {
    width: 11px;
    height: 11px;
    border: 2.5px solid var(--piui-bg);
    background: var(--piui-wire-idle);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--piui-wire-idle) 18%, transparent);
    transition:
      background var(--piui-duration-fast) var(--piui-ease-out),
      box-shadow var(--piui-duration-fast) var(--piui-ease-out);
  }
  .canvas :global(.port.port--wired) {
    background: var(--port);
    box-shadow: 0 0 8px color-mix(in srgb, var(--port) 55%, transparent);
  }
  .canvas :global(.start-edge .piui-edge) {
    stroke: color-mix(in srgb, var(--piui-success) 70%, transparent);
    stroke-dasharray: 5 4;
  }
  .canvas :global(.output-edge .piui-edge) {
    stroke: color-mix(in srgb, var(--piui-decoration-secondary) 70%, transparent);
    stroke-dasharray: 5 4;
  }
  .canvas :global(.port:hover),
  .canvas :global(.svelte-flow__handle.connectingfrom) {
    box-shadow: 0 0 0 5px color-mix(in srgb, var(--port, var(--piui-wire-idle)) 24%, transparent);
  }
  .floating {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px;
    border: 1px solid var(--piui-border-subtle);
    border-radius: var(--piui-radius-md);
    background: color-mix(in srgb, var(--piui-bg-raised) 92%, transparent);
    box-shadow: var(--piui-shadow-1);
    backdrop-filter: blur(6px);
  }
  .floating__label {
    padding: 0 6px 0 4px;
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
  }
  .divider {
    width: 1px;
    height: 18px;
    margin: 0 4px;
    background: var(--piui-border-subtle);
  }
</style>
