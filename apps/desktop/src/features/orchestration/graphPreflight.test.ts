import { it, expect } from 'vitest';
import { emptyGraph, newGraphNode } from './agentGraph';
import { preflightGraph } from './graphPreflight';
it('checks actual reasoning and Fast rather than manifest examples', async () => {
  const graph = emptyGraph(); graph.nodes = [newGraphNode(0)];
  graph.nodes[0]!.profile = {...graph.nodes[0]!.profile,model:'native',reasoning:'high',serviceTier:'fast'};
  const catalog = {protocol:18 as const,harness:'codex' as const,models:[{id:'native',name:'Native',thinkingLevels:['high'],supportsFast:true}],resources:{items:[],warnings:[]}};
  expect(await preflightGraph(graph,async () => catalog)).toEqual([]);
  expect((await preflightGraph(graph,async () => ({...catalog,models:[{id:'native',name:'Native',thinkingLevels:['low']}]}))).map(issue => issue.message)).toContain('Fast is unavailable for this model.');
  expect(await preflightGraph(graph,async () => {throw Error('offline');})).toHaveLength(1);
});
