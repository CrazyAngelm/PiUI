<script lang="ts" module>
  import type { Edge } from '@xyflow/svelte';
  import type { ConnectionKind } from '../../../features/orchestration/agentGraph';

  export interface PiuiEdgeData extends Record<string, unknown> {
    kind: ConnectionKind;
    label?: string;
    both?: boolean;
  }
  export type PiuiFlowEdge = Edge<PiuiEdgeData, 'piui'>;
</script>

<script lang="ts">
  import { BaseEdge, EdgeLabel, getBezierPath, type EdgeProps } from '@xyflow/svelte';

  let { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd, markerStart }: EdgeProps<PiuiFlowEdge> =
    $props();
  const geometry = $derived(getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 }));
  const kind = $derived(data?.kind ?? 'result');
</script>

<BaseEdge {id} path={geometry[0]} {markerEnd} {markerStart} class="piui-edge piui-edge--{kind}{selected ? ' piui-edge--selected' : ''}" interactionWidth={18} />
{#if data?.label}
  <EdgeLabel x={geometry[1]} y={geometry[2]} class="piui-edge-label piui-edge-label--{kind}">{data.label}</EdgeLabel>
{/if}

<style>
  :global(.piui-edge) {
    stroke: var(--piui-text-disabled);
    stroke-width: 1.6;
    fill: none;
  }
  :global(.piui-edge--route) {
    stroke: var(--piui-accent);
  }
  :global(.piui-edge--send) {
    stroke: var(--piui-info);
    stroke-dasharray: 6 5;
  }
  :global(.piui-edge--observe) {
    stroke: var(--piui-text-muted);
    stroke-dasharray: 2 4;
  }
  :global(.piui-edge--spawn) {
    stroke: var(--piui-warning);
    stroke-dasharray: 8 4;
  }
  :global(.piui-edge--selected) {
    stroke-width: 2.6;
    filter: drop-shadow(0 0 3px color-mix(in srgb, currentColor 40%, transparent));
  }
  :global(.piui-edge-label) {
    padding: 1px 6px;
    border: 1px solid var(--piui-border);
    border-radius: var(--piui-radius-full);
    background: var(--piui-bg-raised);
    color: var(--piui-text-muted);
    font-size: var(--piui-text-xs);
    pointer-events: none;
  }
  :global(.piui-edge-label--route) {
    border-color: color-mix(in srgb, var(--piui-accent) 40%, var(--piui-border));
    color: var(--piui-accent);
  }
</style>
