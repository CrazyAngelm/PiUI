import { describe, expect, it } from 'vitest';
import { emptyGraph, graphIssues, newGraphNode, newRouterNode } from './agentGraph';
import { GraphHistory, duplicateNode } from './graphHistory';
import { arrangeResultDependencies, graphNodeHeight, unoccupiedPosition, GRAPH_NODE_WIDTH } from './graphLayout';

describe('graph editing history', () => {
  it('restores deleted nodes and all their connections, and invalidates redo after a new edit', () => {
    const a = newGraphNode(0), b = newGraphNode(1);
    const graph = { ...emptyGraph(), nodes: [a, b], edges: [{from:a.id,to:b.id,kind:'spawn' as const}] };
    const history = new GraphHistory(graph);
    history.record({...graph,nodes:[a],edges:[]});
    expect(history.undo()).toEqual(graph);
    expect(history.redo()?.nodes).toEqual([a]);
    history.undo(); history.record({...graph,name:'Different branch'});
    expect(history.canRedo).toBe(false);
    expect(history.redo()).toBeUndefined();
  });
  it('does not store duplicate snapshots; reset is a new document boundary', () => {
    const graph = emptyGraph(), history = new GraphHistory(graph);
    history.record(graph); expect(history.canUndo).toBe(false);
    history.record({...graph,name:'Saved edit'});
    history.reset(graph); expect(history.undo()).toBeUndefined(); expect(history.redo()).toBeUndefined();
  });
  it('copies a router independently without references or spawn authority', () => {
    const node = newRouterNode(0);
    node.profile = {...node.profile,allowedSpawnProfileIds:['other-profile']};
    node.router = {...node.router!,inputStepId:'upstream'};
    const copy = duplicateNode(node, 'Copy');
    expect(copy.id).not.toBe(node.id); expect(copy.profile.id).not.toBe(node.profile.id);
    expect(copy.profile.allowedSpawnProfileIds).toEqual([]);
    expect(copy.router?.inputStepId).toBe('');
    expect(copy.router?.branches[0]?.id).not.toBe(node.router?.branches[0]?.id);
    expect(copy.router!.branches[0]).not.toBe(node.router!.branches[0]);
    expect(node.router!.branches[0]!.label).not.toBe('Different');
  });
  it('stacks a tall router and independent agents without overlapping their cards', () => {
    const router = newRouterNode(0), other = newGraphNode(1);
    router.router = {...router.router!, branches:[...router.router!.branches,...router.router!.branches.map(b=>({...b,id:crypto.randomUUID()}))]};
    const result = arrangeResultDependencies([router,other],[]);
    expect(result.nodes[1]!.y).toBeGreaterThan(result.nodes[0]!.y + graphNodeHeight(router));
  });
  it('places a new card beyond overlapping cards, using measured heights', () => {
    const a = newGraphNode(0), b = newGraphNode(1);
    const heights = new Map([[a.id,500]]);
    const next = unoccupiedPosition([a,b],{x:a.x,y:a.y+200},graphNodeHeight(b),heights);
    expect(next.x).toBeGreaterThanOrEqual(a.x+GRAPH_NODE_WIDTH);
    const untouched = unoccupiedPosition([a,b],{x:a.x,y:a.y+600},graphNodeHeight(b),heights);
    expect(untouched).toEqual({x:a.x,y:a.y+600});
  });
  it('identifies the affected router without parsing a translated error string', () => {
    const router = newRouterNode(0);
    const issues = graphIssues({...emptyGraph(),nodes:[router]});
    expect(issues.find(issue=>issue.message==='A router needs one direct result input.')?.nodeIds).toEqual([router.id]);
  });
});
