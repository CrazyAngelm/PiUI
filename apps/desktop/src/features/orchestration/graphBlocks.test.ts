import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTemplate } from '../../app/pipelines/templates';
import { TEMPLATES } from '../../app/pipelines/templateCatalog';
import { emptyGraph, newGraphNode, type AgentGraph, type GraphNode } from './agentGraph';
import {
  BLOCK_HEIGHT,
  BLOCK_WIDTH,
  defaultBlockPositions,
  entrySteps,
  exitSteps,
  freeStepPosition,
  readBlockPositions,
  resetBlockPositions,
  withBlockPositions,
  writeBlockPositions,
} from './graphBlocks';
import { GRAPH_NODE_HEIGHT } from './graphLayout';

/** Rendered width of a step card (the canvas reserves a little less in `GRAPH_NODE_WIDTH`). */
const STEP_WIDTH = 248;
const names = (nodes: readonly GraphNode[]): string[] => nodes.map((node) => node.profile.name);
const template = (id: (typeof TEMPLATES)[number]['id']): AgentGraph => buildTemplate(id, 'codex', (value) => value);
const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const memory = new Map<string, string>();
const storage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
};

describe('which steps the Start and Output blocks point at', () => {
  it('starts the first step of a chain and ends after the last one', () => {
    const graph = template('chain');
    expect(names(entrySteps(graph))).toEqual(['Planner']);
    expect(names(exitSteps(graph))).toEqual(['Reviewer']);
  });

  it('starts both researchers of a parallel pipeline', () => {
    const graph = template('parallel');
    expect(names(entrySteps(graph))).toEqual(['Researcher A', 'Researcher B']);
    expect(names(exitSteps(graph))).toEqual(['Synthesis']);
  });

  it('leaves steps that are on call out of both lists', () => {
    const graph = template('orchestrator');
    expect(names(entrySteps(graph))).toEqual(['Orchestrator']);
    expect(names(exitSteps(graph))).toEqual(['Orchestrator']);
  });

  it('ends a router pipeline after both branch targets', () => {
    const graph = template('router');
    expect(names(entrySteps(graph))).toEqual(['Classifier']);
    expect(names(exitSteps(graph))).toEqual(['Bug fixer', 'Feature builder']);
  });
});

describe('default block places', () => {
  it('has none for a graph without steps', () => {
    expect(defaultBlockPositions(emptyGraph())).toBeUndefined();
  });

  it.each(TEMPLATES.map((item) => item.id))('puts Start left and Output right of every step of the %s template', (id) => {
    const graph = template(id);
    const layout = defaultBlockPositions(graph)!;
    expect(layout.start.x + BLOCK_WIDTH).toBeLessThan(Math.min(...graph.nodes.map((node) => node.x)));
    expect(layout.output.x).toBeGreaterThanOrEqual(Math.max(...graph.nodes.map((node) => node.x)) + STEP_WIDTH);
  });

  it('never covers a step of the orchestrator template', () => {
    const graph = template('orchestrator');
    const { output } = defaultBlockPositions(graph)!;
    const block = { x: output.x, y: output.y, w: BLOCK_WIDTH, h: BLOCK_HEIGHT };
    for (const node of graph.nodes) expect(overlap(block, { x: node.x, y: node.y, w: STEP_WIDTH, h: GRAPH_NODE_HEIGHT })).toBe(false);
  });

  it('lines Start up with the steps it starts', () => {
    const graph = template('chain');
    const { start, output } = defaultBlockPositions(graph)!;
    expect(start.y).toBe(graph.nodes[0].y + 16);
    expect(output.y).toBe(graph.nodes[2].y + 16);
  });
});

describe('keeping the blocks where they are', () => {
  it('places missing blocks once and returns the same graph afterwards', () => {
    const graph = template('chain');
    const placed = withBlockPositions(graph);
    expect(placed.layout).toEqual(defaultBlockPositions(graph));
    expect(withBlockPositions(placed)).toBe(placed);
  });

  it('does not follow a step that moves', () => {
    const placed = withBlockPositions(template('chain'));
    const moved = { ...placed, nodes: placed.nodes.map((node, index) => (index === 0 ? { ...node, x: 900, y: 500 } : node)) };
    expect(withBlockPositions(moved).layout).toBe(placed.layout);
  });

  it('drops the blocks of a graph whose steps were all removed', () => {
    const placed = withBlockPositions(template('chain'));
    const empty = withBlockPositions({ ...placed, nodes: [], edges: [] });
    expect(empty.layout).toBeUndefined();
    expect('layout' in empty).toBe(false);
    const bare = emptyGraph();
    expect(withBlockPositions(bare)).toBe(bare);
  });

  it('places the blocks around the steps again on request', () => {
    const placed = withBlockPositions(template('chain'));
    const moved: AgentGraph = { ...placed, layout: { start: { x: 5, y: 5 }, output: { x: 7, y: 7 } } };
    expect(resetBlockPositions(moved).layout).toEqual(defaultBlockPositions(moved));
    expect(resetBlockPositions(emptyGraph()).layout).toBeUndefined();
  });
});

describe('a place for a new step', () => {
  it('returns a free point unchanged', () => {
    const graph = withBlockPositions(template('chain'));
    expect(freeStepPosition(graph, { x: 40, y: 800 })).toEqual({ x: 40, y: 800 });
  });

  it('moves a point that sits on a step one row down, in the same column', () => {
    const graph = withBlockPositions(template('chain'));
    const step = graph.nodes[0];
    expect(freeStepPosition(graph, { x: step.x, y: step.y })).toEqual({ x: step.x, y: step.y + 176 });
  });

  it('gives three steps asked for at the same point three different places', () => {
    let graph = emptyGraph();
    const places: { x: number; y: number }[] = [];
    for (let index = 0; index < 3; index += 1) {
      const place = freeStepPosition(graph, { x: 36, y: 134 });
      places.push(place);
      graph = withBlockPositions({ ...graph, nodes: [...graph.nodes, { ...newGraphNode(index), ...place }] });
    }
    expect(new Set(places.map((place) => `${place.x},${place.y}`)).size).toBe(3);
    for (const [index, a] of places.entries()) {
      for (const b of places.slice(index + 1)) expect(overlap({ ...a, w: STEP_WIDTH, h: GRAPH_NODE_HEIGHT }, { ...b, w: STEP_WIDTH, h: GRAPH_NODE_HEIGHT })).toBe(false);
    }
  });

  it('does not land on the Output block', () => {
    const graph = withBlockPositions(template('chain'));
    const { output } = graph.layout!;
    const place = freeStepPosition(graph, { x: output.x, y: output.y });
    expect(place).not.toEqual({ x: output.x, y: output.y });
  });
});

describe('storing the block places', () => {
  beforeEach(() => {
    memory.clear();
    vi.stubGlobal('localStorage', storage);
  });

  it('round-trips the places of one graph in one scope', () => {
    const graph = withBlockPositions(template('chain'));
    writeBlockPositions('workspace', graph);
    expect(readBlockPositions('workspace', graph.id)).toEqual(graph.layout);
    expect(readBlockPositions('portable', graph.id)).toBeUndefined();
    expect(readBlockPositions('workspace', 'other')).toBeUndefined();
  });

  it('keeps negative coordinates', () => {
    const graph: AgentGraph = { ...template('chain'), layout: { start: { x: -400, y: -30 }, output: { x: 900, y: 60 } } };
    writeBlockPositions('workspace', graph);
    expect(readBlockPositions('workspace', graph.id)).toEqual(graph.layout);
  });

  it.each([
    ['garbage', 'not json'],
    ['a missing point', JSON.stringify({ start: { x: 1, y: 2 } })],
    ['a text coordinate', JSON.stringify({ start: { x: '1', y: 2 }, output: { x: 3, y: 4 } })],
    ['a non-finite coordinate', '{"start":{"x":1,"y":2},"output":{"x":1e999,"y":4}}'],
    ['null', 'null'],
    ['a number', '7'],
  ])('falls back to automatic places for %s', (_label, text) => {
    memory.set('piui.graph.blocks.workspace.id', text);
    expect(readBlockPositions('workspace', 'id')).toBeUndefined();
  });

  it('forgets the places of a graph that has none', () => {
    const graph = withBlockPositions(template('chain'));
    writeBlockPositions('workspace', graph);
    const { layout: _layout, ...bare } = graph;
    writeBlockPositions('workspace', bare);
    expect(readBlockPositions('workspace', graph.id)).toBeUndefined();
  });

  it('never throws without localStorage', () => {
    vi.stubGlobal('localStorage', undefined);
    const graph = withBlockPositions(template('chain'));
    expect(() => writeBlockPositions('workspace', graph)).not.toThrow();
    expect(readBlockPositions('workspace', graph.id)).toBeUndefined();
  });
});
