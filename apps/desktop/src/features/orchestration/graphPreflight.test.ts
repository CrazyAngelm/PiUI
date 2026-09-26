import { it, expect } from 'vitest';
import { emptyGraph, newGraphNode, newLlmNode, newRouterNode, newScriptNode } from './agentGraph';
import { preflightGraph } from './graphPreflight';
it('checks actual reasoning and Fast rather than manifest examples', async () => {
  const graph = emptyGraph(); graph.nodes = [newGraphNode(0)];
  graph.nodes[0]!.profile = {...graph.nodes[0]!.profile,model:'native',reasoning:'high',serviceTier:'fast'};
  const catalog = {protocol:18 as const,harness:'codex' as const,models:[{id:'native',name:'Native',thinkingLevels:['high'],supportsFast:true}],resources:{items:[],warnings:[]}};
  expect(await preflightGraph(graph,async () => catalog)).toEqual([]);
  expect((await preflightGraph(graph,async () => ({...catalog,models:[{id:'native',name:'Native',thinkingLevels:['low']}]}))).map(issue => issue.message)).toContain('Fast is unavailable for this model.');
  expect(await preflightGraph(graph,async () => {throw Error('offline');})).toHaveLength(1);
});
it('does not require a native model catalog for program routers', async () => {
  const graph = emptyGraph(); graph.nodes = [newRouterNode(0)];
  expect(await preflightGraph(graph, async () => { throw Error('program routers have no native profile'); })).toEqual([]);
});
it('never asks a native catalog about scripts and refuses model calls without a read-only mode', async () => {
  const scripts = emptyGraph(); scripts.nodes = [newScriptNode(0)];
  expect(await preflightGraph(scripts, async () => { throw Error('scripts have no native profile'); })).toEqual([]);
  const calls = emptyGraph(); calls.nodes = [newLlmNode(0)];
  calls.nodes[0]!.profile = { ...calls.nodes[0]!.profile, harness: 'prime-agent', model: 'native', permissionMode: 'read-only', serviceTier: undefined };
  const catalog = { protocol: 18 as const, harness: 'prime-agent' as const, models: [{ id: 'native', name: 'Native' }], resources: { items: [], warnings: [] } };
  expect((await preflightGraph(calls, async () => catalog)).map(issue => issue.message))
    .toContain(`${calls.nodes[0]!.id}: Prime Agent cannot run a single model call read-only.`);
});
