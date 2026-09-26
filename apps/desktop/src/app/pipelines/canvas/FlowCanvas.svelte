<script lang="ts">
  import '@xyflow/svelte/dist/style.css';
  import { Background, BackgroundVariant, MarkerType, MiniMap, Panel, SvelteFlow, type Connection } from '@xyflow/svelte';
  import Minus from '@lucide/svelte/icons/minus';
  import Plus from '@lucide/svelte/icons/plus';
  import Maximize from '@lucide/svelte/icons/maximize';
  import LayoutGrid from '@lucide/svelte/icons/layout-grid';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import Redo2 from '@lucide/svelte/icons/redo-2';
  import Eye from '@lucide/svelte/icons/eye';
  import EyeOff from '@lucide/svelte/icons/eye-off';
  import { t } from '../../../features/locale/language';
  import type { ConnectionKind } from '../../../features/orchestration/agentGraph';
  import { IconButton, Segmented, toasts } from '../../../lib/ui';
  import { edgeKey, type PipelineEditorStore } from '../editorStore.svelte';
  import AgentNodeCard, { type AgentFlowNode } from './AgentNodeCard.svelte';
  import RouterNodeCard, { type RouterFlowNode } from './RouterNodeCard.svelte';
  import PiuiEdge, { type PiuiFlowEdge } from './PiuiEdge.svelte';
  import StartNodeCard, { START_NODE_ID, type StartFlowNode } from './StartNodeCard.svelte';
  import { RUN_INPUT_ISSUES } from '../../../host-api/runInputs';

  const INPUT_ISSUES: ReadonlySet<string> = new Set(
    [RUN_INPUT_ISSUES.count, RUN_INPUT_ISSUES.names, RUN_INPUT_ISSUES.labels, RUN_INPUT_ISSUES.options, RUN_INPUT_ISSUES.defaults],
  );
  import FlowBridge, { type FlowApi } from './FlowBridge.svelte';
  import { connectionLabel } from './connectionLabel';

  interface Props {
    editor: PipelineEditorStore;
    /** Called when the user double-clicks empty canvas (flow coordinates). */
    onAddRequest: (position: { x: number; y: number }) => void;
    onready: (api: FlowApi) => void;
  }
  let { editor, onAddRequest, onready }: Props = $props();

  type FlowNode = AgentFlowNode | RouterFlowNode | StartFlowNode;
  const nodeTypes = { agent: AgentNodeCard, router: RouterNodeCard, start: StartNodeCard };
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

  $effect(() => {
    const read = () => {
      const theme = document.documentElement.dataset.theme;
      colorMode = theme === 'dark' || theme === 'light' ? theme : 'system';
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  });

  function sync(): void {
    const graph = editor.graph;
    const readOnly = editor.readOnly;
    // Accessible names of nodes and connections (Svelte Flow defaults use ids).
    const names = new Map(graph.nodes.map((node) => [
      node.id,
      node.profile.name || $t(node.kind === 'router' ? 'Router' : node.executor?.type === 'script' ? 'Untitled script' : 'Untitled agent'),
    ]));
    const graphNodes = graph.nodes.map((node) => ({
      id: node.id,
      type: node.kind === 'router' ? 'router' : 'agent',
      ariaLabel: names.get(node.id),
      position: { x: node.x, y: node.y },
      data: { node, problems: editor.nodeProblems(node.id).length, readOnly },
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
          id: START_NODE_ID,
          type: 'start',
          ariaLabel: $t('Start'),
          position: { x, y },
          data: { inputs: graph.inputs ?? [], problems: inputProblems },
          selected: editor.selectedId === START_NODE_ID,
          draggable: false,
          deletable: false,
          connectable: false,
        } as StartFlowNode,
      );
      for (const entry of entries) {
        startEdges.push({
          id: `${START_NODE_ID}:${entry.id}`,
          type: 'piui',
          source: START_NODE_ID,
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
    // Assign once: reading `nodes` here would make this effect depend on itself.
    nodes = [...startNodes, ...graphNodes];
    edges = [...startEdges, ...graph.edges.map((edge): PiuiFlowEdge => {
      const router = edge.kind === 'route' ? graph.nodes.find((node) => node.id === edge.from) : undefined;
      const label = edge.kind === 'route' ? router?.router?.branches.find((branch) => branch.id === edge.branchId)?.label : undefined;
      return {
        id: edgeKey(edge),
        type: 'piui',
        source: edge.from,
        target: edge.to,
        ariaLabel: connectionLabel($t, edge.kind, names.get(edge.from) ?? '', names.get(edge.to) ?? ''),
        sourceHandle: edge.kind === 'route' ? `branch:${edge.branchId ?? ''}` : 'out',
        targetHandle: 'in',
        data: { kind: edge.kind, label },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: markerColor[edge.kind] },
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
    void editor.selectedEdge;
    void editor.issues;
    void editor.preflight;
    void editor.showCollaboration;
    void editor.busy;
    sync();
  });

  function beforeConnect(connection: Connection): false {
    const error = editor.connect(connection.source, connection.target, connection.sourceHandle);
    if (error) toasts.error($t('Cannot connect'), $t(error));
    sync();
    return false;
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
    proOptions={{ hideAttribution: true }}
    class="piui-flow"
    onbeforeconnect={beforeConnect}
    onbeforedelete={async ({ nodes: removedNodes, edges: removedEdges }) => {
      editor.removeSelection(
        removedNodes.map((node) => node.id).filter((id) => id !== START_NODE_ID),
        removedEdges.map((edge) => edge.id).filter((id) => !id.startsWith(`${START_NODE_ID}:`)),
      );
      return false;
    }}
    onnodedragstop={({ nodes: moved }) =>
      editor.movedNodes(moved.filter((node) => node.id !== START_NODE_ID).map((node) => ({ id: node.id, x: node.position.x, y: node.position.y })))}
    onnodeclick={({ node }) => {
      editor.selectedId = node.id;
      editor.selectedEdge = '';
    }}
    onedgeclick={({ edge }) => {
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
            editor.arrange();
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
    --xy-background-pattern-dots-color-default: color-mix(in srgb, var(--piui-text-muted) 28%, transparent);
    --xy-minimap-background-color-default: var(--piui-bg-raised);
    --xy-minimap-mask-background-color-default: color-mix(in srgb, var(--piui-bg) 72%, transparent);
    --xy-edge-stroke-default: var(--piui-text-disabled);
    --xy-connectionline-stroke-default: var(--piui-accent);
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
    width: 10px;
    height: 10px;
    border: 2px solid var(--piui-surface-1);
    background: var(--piui-text-muted);
  }
  .canvas :global(.start-edge .piui-edge) {
    stroke: color-mix(in srgb, var(--piui-success) 70%, transparent);
    stroke-dasharray: 5 4;
  }
  .canvas :global(.port:hover),
  .canvas :global(.svelte-flow__handle.connectingfrom),
  .canvas :global(.svelte-flow__handle.valid) {
    background: var(--piui-accent);
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
