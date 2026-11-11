<script lang="ts" module>
  import type { Edge } from '@xyflow/svelte';
  import type { ConnectionKind } from '../../../features/orchestration/agentGraph';

  export interface PiuiEdgeData extends Record<string, unknown> {
    kind: ConnectionKind;
    label?: string;
    both?: boolean;
    /** Wire color of the source step (result and route connections). */
    wire?: string;
    /** Just connected: plays the strike animation once. */
    fresh?: boolean;
  }
  export type PiuiFlowEdge = Edge<PiuiEdgeData, 'piui'>;
</script>

<script lang="ts">
  import { BaseEdge, EdgeLabel, getBezierPath, type EdgeProps } from '@xyflow/svelte';

  let { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd, markerStart }: EdgeProps<PiuiFlowEdge> =
    $props();
  const geometry = $derived(getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 }));
  const kind = $derived(data?.kind ?? 'result');
  const wire = $derived(data?.wire);
</script>

<BaseEdge
  {id}
  path={geometry[0]}
  {markerEnd}
  {markerStart}
  style={wire ? `--wire: ${wire}` : undefined}
  class="piui-edge piui-edge--{kind}{wire ? ' piui-edge--wired' : ''}{selected ? ' piui-edge--selected' : ''}"
  interactionWidth={18}
/>
{#if wire && data?.fresh}
  <g class="piui-edge-strike" style:--wire={wire} aria-hidden="true">
    <path class="piui-edge-strike__bolt" d={geometry[0]} pathLength="1" />
    <circle class="piui-edge-strike__spark" r="4">
      <animateMotion dur="0.55s" repeatCount="1" fill="freeze" path={geometry[0]} />
    </circle>
  </g>
{/if}
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
  :global(.piui-edge.piui-edge--wired) {
    stroke: var(--wire);
    stroke-width: 2;
    stroke-linecap: round;
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
  :global(.piui-edge--selected),
  :global(.piui-edge.piui-edge--wired.piui-edge--selected) {
    stroke-width: 2.8;
    filter: drop-shadow(0 0 4px color-mix(in srgb, var(--wire, currentColor) 60%, transparent));
  }
  .piui-edge-strike {
    pointer-events: none;
  }
  .piui-edge-strike__bolt {
    fill: none;
    stroke: var(--wire);
    stroke-width: 4;
    stroke-linecap: round;
    stroke-dasharray: 1;
    stroke-dashoffset: 1;
    filter: drop-shadow(0 0 6px var(--wire));
    animation: piui-edge-strike 0.9s var(--piui-ease-out, ease-out) forwards;
  }
  .piui-edge-strike__spark {
    fill: var(--wire);
    filter: drop-shadow(0 0 6px var(--wire)) drop-shadow(0 0 2px var(--wire));
    animation: piui-edge-spark 0.75s ease-out forwards;
  }
  @keyframes piui-edge-strike {
    0% {
      stroke-dashoffset: 1;
      opacity: 1;
    }
    55% {
      stroke-dashoffset: 0;
      opacity: 1;
    }
    100% {
      stroke-dashoffset: 0;
      opacity: 0;
    }
  }
  @keyframes piui-edge-spark {
    0%,
    70% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .piui-edge-strike {
      display: none;
    }
  }
  :global(:root[data-reduced-motion='reduce']) .piui-edge-strike {
    display: none;
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
