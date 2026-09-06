import { describe, expect, it } from 'vitest';
import { compileGraph, emptyGraph, newGraphNode, graphErrors, patternEdges } from './agentGraph';
describe('agent graph', () => {
  function graph() { const graph = emptyGraph(); graph.name = 'Mixed'; graph.nodes = [newGraphNode(0), newGraphNode(1)]; graph.nodes.forEach(node => { node.profile = { ...node.profile, model: 'model' }; }); graph.nodes[1]!.profile = { ...graph.nodes[1]!.profile, harness: 'prime-agent', permissionMode: 'native', serviceTier: undefined }; return graph; }
  it('compiles cross-harness results independently from message permissions', () => {
    const value = graph(); value.edges = patternEdges(value.nodes, 'sequential');
    const compiled = compileGraph(value);
    expect(graphErrors(value)).toEqual([]);
    expect(compiled.profiles.map(profile => profile.harness)).toEqual(['codex', 'prime-agent']);
    expect(compiled.pipeline.steps[1]!.dependencyStepIds).toEqual([value.nodes[0]!.id]);
    expect(compiled.team.sendEdges).toEqual([]);
  });
  it('rejects result cycles and delegation to a stronger profile', () => {
    const value = graph(); const [a,b] = value.nodes;
    value.edges = [{ from:a!.id, to:b!.id, kind:'spawn' }];
    expect(graphErrors(value)).toContain('Child permissions must be the same or lower.');
    value.edges = [{ from:a!.id, to:b!.id, kind:'result' }, { from:b!.id, to:a!.id, kind:'result' }];
    expect(graphErrors(value)).toContain('Result connections must not form a cycle.');
  });
  it('allows message cycles without creating execution cycles', () => { const value = graph(); value.edges = patternEdges(value.nodes, 'peer'); expect(graphErrors(value)).toEqual([]); expect(compileGraph(value).team.sendEdges).toHaveLength(2); });
});
