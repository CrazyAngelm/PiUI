/**
 * The Start and Output blocks of a pipeline canvas. They are not steps: nothing
 * here is compiled, saved to the host or exported. Only their place on the
 * canvas is kept (`AgentGraph.layout`), as rebuildable UI metadata.
 *
 * Pure module: no host, locale or Svelte imports (the web build bundles it).
 */
import type { AgentGraph, GraphLayout, GraphNode } from './agentGraph';
import { GRAPH_NODE_HEIGHT, unoccupiedPosition } from './graphLayout';

/** Rendered size of the Start and Output cards. */
export const BLOCK_WIDTH = 196;
export const BLOCK_HEIGHT = 68;
/** Start's left edge sits this far left of the leftmost step; Output's this far right of the rightmost step's left edge. */
const START_OFFSET = 290;
const OUTPUT_OFFSET = 300;
/** Lines a block's port up with the port of a step card without inputs. */
const DROP = 16;

const flows = (kind: string): boolean => kind === 'result' || kind === 'route';
const scheduled = (node: GraphNode): boolean => node.executionMode !== 'callable';

/** Scheduled steps with nothing before them: they start when the run begins. */
export function entrySteps(graph: AgentGraph): GraphNode[] {
  const waiting = new Set(graph.edges.filter((edge) => flows(edge.kind)).map((edge) => edge.to));
  return graph.nodes.filter((node) => scheduled(node) && !waiting.has(node.id));
}

/** Scheduled steps with nothing after them. */
export function exitSteps(graph: AgentGraph): GraphNode[] {
  const feeding = new Set(graph.edges.filter((edge) => flows(edge.kind)).map((edge) => edge.from));
  return graph.nodes.filter((node) => scheduled(node) && !feeding.has(node.id));
}

const level = (nodes: readonly GraphNode[]): number => Math.round(nodes.reduce((sum, node) => sum + node.y, 0) / nodes.length) + DROP;

/** Where the blocks go when nobody placed them: left and right of every step, so they never cover one. */
export function defaultBlockPositions(graph: AgentGraph): GraphLayout | undefined {
  if (!graph.nodes.length) return undefined;
  const entries = entrySteps(graph);
  const exits = exitSteps(graph);
  return {
    start: { x: Math.min(...graph.nodes.map((node) => node.x)) - START_OFFSET, y: level(entries.length ? entries : graph.nodes) },
    output: { x: Math.max(...graph.nodes.map((node) => node.x)) + OUTPUT_OFFSET, y: level(exits.length ? exits : graph.nodes) },
  };
}

/** Blocks stay where they are; they are placed only when missing, and a graph without steps has none. */
export function withBlockPositions(graph: AgentGraph): AgentGraph {
  if (!graph.nodes.length) {
    if (graph.layout === undefined) return graph;
    const { layout: _blocks, ...rest } = graph;
    return rest;
  }
  return graph.layout ? graph : { ...graph, layout: defaultBlockPositions(graph) };
}

/** The same graph with both blocks placed again around its steps (Arrange, a replaced draft). */
export function resetBlockPositions(graph: AgentGraph): AgentGraph {
  const { layout: _blocks, ...rest } = graph;
  return withBlockPositions(rest);
}

/** Arrange's row distance: card height plus the gap between rows. */
const ROW = 176;

/**
 * A place for a new step: the asked one, else the nearest free row below it (it stays in view),
 * else to the right. Never on top of a step or of the Start and Output blocks.
 */
export function freeStepPosition(graph: AgentGraph, point: { x: number; y: number }): { x: number; y: number } {
  const blocks = graph.layout;
  const taken = [...graph.nodes, ...(blocks ? [{ id: ' start', ...blocks.start }, { id: ' output', ...blocks.output }] : [])];
  const measured = new Map<string, number>();
  for (let row = 0; row < 8; row += 1) {
    const place = { x: point.x, y: point.y + row * ROW };
    if (unoccupiedPosition(taken, place, GRAPH_NODE_HEIGHT, measured).x === place.x) return place;
  }
  return unoccupiedPosition(taken, point, GRAPH_NODE_HEIGHT, measured);
}

const blockKey = (scope: string, graphId: string): string => `piui.graph.blocks.${scope}.${graphId}`;

function point(value: unknown): { x: number; y: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { x, y } = value as { x?: unknown; y?: unknown };
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

/** Block places are rebuildable UI metadata, kept next to the step positions in localStorage. */
export function readBlockPositions(scope: string, graphId: string): GraphLayout | undefined {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(blockKey(scope, graphId)) ?? 'null');
    if (typeof stored !== 'object' || stored === null) return undefined;
    const start = point((stored as { start?: unknown }).start);
    const output = point((stored as { output?: unknown }).output);
    return start && output ? { start, output } : undefined;
  } catch {
    return undefined;
  }
}

export function writeBlockPositions(scope: string, graph: AgentGraph): void {
  try {
    if (graph.layout) localStorage.setItem(blockKey(scope, graph.id), JSON.stringify(graph.layout));
    else localStorage.removeItem(blockKey(scope, graph.id));
  } catch {
    // The definition itself is already persisted.
  }
}
