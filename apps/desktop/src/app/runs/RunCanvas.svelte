<script lang="ts">
  import '@xyflow/svelte/dist/style.css';
  import { Background, BackgroundVariant, MarkerType, Panel, SvelteFlow } from '@xyflow/svelte';
  import Minus from '@lucide/svelte/icons/minus';
  import Plus from '@lucide/svelte/icons/plus';
  import Maximize from '@lucide/svelte/icons/maximize';
  import { t } from '../../features/locale/language';
  import type { ConnectionKind } from '../../features/orchestration/agentGraph';
  import type { OrchestrationRunV6 } from '../../host-api/orchestrationClient';
  import { IconButton } from '../../lib/ui';
  import PiuiEdge, { type PiuiFlowEdge } from '../pipelines/canvas/PiuiEdge.svelte';
  import FlowBridge, { type FlowApi } from '../pipelines/canvas/FlowBridge.svelte';
  import RunNodeCard, { type RunFlowNode } from './RunNodeCard.svelte';
  import { buildRunGraph } from './runGraph';
  import type { StepView } from './runPresentation';

  interface Props {
    run: OrchestrationRunV6;
    workspaceId: string;
    views: readonly StepView[];
    selectedId: string;
    activity: (sessionId: string | undefined) => string;
    onSelect: (stepId: string) => void;
  }
  let { run, workspaceId, views, selectedId, activity, onSelect }: Props = $props();

  const nodeTypes = { step: RunNodeCard };
  const edgeTypes = { piui: PiuiEdge };
  const markerColor: Record<ConnectionKind, string> = {
    result: 'var(--piui-text-disabled)',
    route: 'var(--piui-accent)',
    send: 'var(--piui-info)',
    observe: 'var(--piui-text-muted)',
    spawn: 'var(--piui-warning)',
  };

  let container = $state<HTMLDivElement | null>(null);
  let api = $state.raw<FlowApi | undefined>();
  let nodes = $state.raw<RunFlowNode[]>([]);
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

  // The frozen definition decides the shape; the task journal decides colour.
  const graph = $derived(buildRunGraph(run, workspaceId));

  $effect(() => {
    const byStep = new Map(views.map((view) => [view.stepId, view]));
    const statusOf = (stepId: string) => byStep.get(stepId)?.state;
    nodes = graph.nodes.flatMap((node) => {
      const view = byStep.get(node.id);
      if (!view) return [];
      return [
        {
          id: node.id,
          type: 'step' as const,
          position: { x: node.x, y: node.y },
          data: {
            view,
            profile: node.kind === 'router' ? undefined : node.profile,
            router: node.kind === 'router',
            activity: activity(view.sessionId),
          },
          selected: node.id === selectedId,
          draggable: false,
          connectable: false,
          deletable: false,
        },
      ];
    });
    edges = graph.edges.map((edge) => {
      const router = edge.kind === 'route' ? graph.nodes.find((node) => node.id === edge.from) : undefined;
      const label = edge.kind === 'route' ? router?.router?.branches.find((branch) => branch.id === edge.branchId)?.label : undefined;
      const flowing = statusOf(edge.to) === 'running' || (statusOf(edge.from) === 'running' && edge.kind !== 'result');
      const taken = statusOf(edge.from) === 'succeeded' && statusOf(edge.to) !== 'skipped' && statusOf(edge.to) !== 'onCall';
      return {
        id: `${edge.from}:${edge.to}:${edge.kind}:${edge.branchId ?? ''}`,
        type: 'piui' as const,
        source: edge.from,
        target: edge.to,
        sourceHandle: 'out',
        targetHandle: 'in',
        data: { kind: edge.kind, label },
        animated: flowing,
        class: taken ? 'run-edge--taken' : statusOf(edge.to) === 'skipped' ? 'run-edge--skipped' : '',
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: markerColor[edge.kind] },
        selectable: false,
        deletable: false,
      };
    });
  });

</script>

<div class="canvas" bind:this={container}>
  <SvelteFlow
    bind:nodes
    bind:edges
    {nodeTypes}
    {edgeTypes}
    {colorMode}
    fitView
    fitViewOptions={{ padding: 0.2, maxZoom: 1.05 }}
    minZoom={0.2}
    maxZoom={1.8}
    nodesDraggable={false}
    nodesConnectable={false}
    elementsSelectable={true}
    deleteKey={null}
    proOptions={{ hideAttribution: true }}
    class="piui-flow"
    onnodeclick={({ node }) => onSelect(node.id)}
    onpaneclick={() => onSelect('')}
  >
    <FlowBridge {container} onready={(next) => (api = next)} />
    <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} />
    <Panel position="bottom-left">
      <div class="floating" role="toolbar" aria-label={$t('Canvas controls')}>
        <IconButton size="sm" label={$t('Zoom out')} onclick={() => api?.zoomOut()}><Minus /></IconButton>
        <IconButton size="sm" label={$t('Zoom in')} onclick={() => api?.zoomIn()}><Plus /></IconButton>
        <IconButton size="sm" label={$t('Fit to screen')} onclick={() => api?.fitView()}><Maximize /></IconButton>
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
    --xy-edge-stroke-default: var(--piui-text-disabled);
    --xy-node-border-radius-default: 12px;
    background: var(--piui-bg);
  }
  .canvas :global(.svelte-flow__node) {
    border: 0;
    background: transparent;
    box-shadow: none;
    padding: 0;
  }
  .canvas :global(.svelte-flow__node:focus-visible) {
    outline: 2px solid var(--piui-focus);
    outline-offset: 3px;
    border-radius: 12px;
  }
  .canvas :global(.run-port) {
    width: 8px;
    height: 8px;
    border: 2px solid var(--piui-surface-1);
    background: var(--piui-text-disabled);
    pointer-events: none;
  }
  .canvas :global(.run-edge--taken .piui-edge--result) {
    stroke: var(--piui-success);
    stroke-width: 2;
  }
  .canvas :global(.run-edge--skipped .piui-edge) {
    opacity: 0.35;
  }
  .canvas :global(.svelte-flow__edge.animated .piui-edge) {
    stroke: var(--piui-accent);
    stroke-dasharray: 6 5;
    animation: run-flow 0.6s linear infinite;
  }
  @keyframes run-flow {
    to {
      stroke-dashoffset: -11;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .canvas :global(.svelte-flow__edge.animated .piui-edge) {
      animation: none;
    }
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
</style>
