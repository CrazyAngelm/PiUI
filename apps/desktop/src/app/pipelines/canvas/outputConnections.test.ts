import { describe, expect, it } from 'vitest';
import { compileGraph, emptyGraph, newGraphNode, newRouterNode } from '../../../features/orchestration/agentGraph';
import { buildTemplate } from '../templates';
import { outputConnections } from './outputConnections';

describe('Output completion links', () => {
  it.each([
    ['chain', ['Reviewer']],
    ['parallel', ['Synthesis']],
    ['orchestrator', ['Orchestrator']],
    ['review', ['Reviewer']],
    ['router', ['Bug fixer', 'Feature builder']],
  ] as const)('connects the terminal scheduled steps of %s without changing saved data', (id, names) => {
    const graph = buildTemplate(id, 'codex', (value) => value);
    const saved = compileGraph(graph);
    const { sources, implicit } = outputConnections(graph);
    expect(implicit).toBe(true);
    expect(graph.nodes.filter((node) => sources.has(node.id)).map((node) => node.profile.name)).toEqual(names);
    expect(compileGraph(graph)).toEqual(saved);
    expect(graph.outputs).toBeUndefined();
  });

  it('moves the completion link when a dependency is added or removed, ignoring collaboration', () => {
    const graph = emptyGraph();
    const [first, second] = [newGraphNode(0), newGraphNode(1)];
    graph.nodes = [first, second];
    graph.edges = [{ from: first.id, to: second.id, kind: 'send' }];
    expect([...outputConnections(graph).sources]).toEqual([first.id, second.id]);
    graph.edges.push({ from: first.id, to: second.id, kind: 'result' });
    expect([...outputConnections(graph).sources]).toEqual([second.id]);
    graph.edges.pop();
    expect([...outputConnections(graph).sources]).toEqual([first.id, second.id]);
  });

  it('uses only explicit output sources, deduplicates fields and returns to completion links when removed', () => {
    const graph = buildTemplate('chain', 'codex', (value) => value);
    const source = graph.nodes[0].id;
    graph.outputs = [
      { name: 'first', kind: 'text', sourceStepId: source },
      { name: 'second', kind: 'text', sourceStepId: source },
    ];
    expect(outputConnections(graph)).toEqual({ sources: new Set([source]), implicit: false });
    graph.outputs = [];
    expect(outputConnections(graph)).toEqual({ sources: new Set([graph.nodes[2].id]), implicit: true });
  });

  it('does not disguise a missing explicit source as an automatic result', () => {
    const graph = buildTemplate('chain', 'codex', (value) => value);
    graph.outputs = [{ name: 'result', kind: 'text', sourceStepId: 'missing' }];
    expect(outputConnections(graph)).toEqual({ sources: new Set(), implicit: false });
  });

  it('preserves an explicitly mapped router result without inventing implicit router exits', () => {
    const graph = buildTemplate('router', 'codex', (value) => value);
    const router = graph.nodes.find((node) => node.kind === 'router')!;
    graph.outputs = [{ name: 'selection', kind: 'text', sourceStepId: router.id }];
    expect(outputConnections(graph)).toEqual({ sources: new Set([router.id]), implicit: false });
  });

  it('does not invent completion links for an empty graph, callable-only graph, router or dependency cycle', () => {
    const graph = emptyGraph();
    expect(outputConnections(graph).sources.size).toBe(0);
    graph.nodes = [{ ...newGraphNode(0), executionMode: 'callable' }, newRouterNode(1)];
    expect(outputConnections(graph).sources.size).toBe(0);
    graph.nodes = [newGraphNode(0), newGraphNode(1)];
    graph.edges = [
      { from: graph.nodes[0].id, to: graph.nodes[1].id, kind: 'result' },
      { from: graph.nodes[1].id, to: graph.nodes[0].id, kind: 'result' },
    ];
    expect(outputConnections(graph).sources.size).toBe(0);
  });
});
