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

  it('keeps the completion link of a final step beside a declared result, deduplicating fields', () => {
    const graph = buildTemplate('chain', 'codex', (value) => value);
    const source = graph.nodes[0].id;
    graph.outputs = [
      { name: 'first', kind: 'text', sourceStepId: source },
      { name: 'second', kind: 'text', sourceStepId: source },
    ];
    expect(outputConnections(graph)).toEqual({
      declared: new Set([source]),
      completion: new Set([graph.nodes[2].id]),
      sources: new Set([source, graph.nodes[2].id]),
      implicit: false,
    });
    graph.outputs = [];
    expect(outputConnections(graph)).toEqual({
      declared: new Set(),
      completion: new Set([graph.nodes[2].id]),
      sources: new Set([graph.nodes[2].id]),
      implicit: true,
    });
  });

  it('draws one solid wire, not a completion wire, for a declared final step', () => {
    const graph = buildTemplate('chain', 'codex', (value) => value);
    const last = graph.nodes[2].id;
    graph.outputs = [{ name: 'verdict', kind: 'text', sourceStepId: last }];
    expect(outputConnections(graph)).toEqual({ declared: new Set([last]), completion: new Set(), sources: new Set([last]), implicit: false });
  });

  it('does not show a missing explicit source as a declared result', () => {
    const graph = buildTemplate('chain', 'codex', (value) => value);
    graph.outputs = [{ name: 'result', kind: 'text', sourceStepId: 'missing' }];
    expect(outputConnections(graph)).toEqual({
      declared: new Set(),
      completion: new Set([graph.nodes[2].id]),
      sources: new Set([graph.nodes[2].id]),
      implicit: false,
    });
  });

  it('keeps an explicitly mapped router result beside the completion links of its branches', () => {
    const graph = buildTemplate('router', 'codex', (value) => value);
    const router = graph.nodes.find((node) => node.kind === 'router')!;
    graph.outputs = [{ name: 'selection', kind: 'text', sourceStepId: router.id }];
    const result = outputConnections(graph);
    expect(result.declared).toEqual(new Set([router.id]));
    expect(graph.nodes.filter((node) => result.completion.has(node.id)).map((node) => node.profile.name)).toEqual(['Bug fixer', 'Feature builder']);
    expect(result.sources.size).toBe(3);
    expect(result.implicit).toBe(false);
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
