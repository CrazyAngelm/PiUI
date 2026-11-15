import { describe, expect, it } from 'vitest';
import { edgeKey } from '../../../features/orchestration/graphCanvasEditing';
import { isPresentationEdge, presentationEdge, presentationEdgeId, presentationNodeIds } from './graphRenderIdentity';

describe('portable graph rendering identities', () => {
  it('keeps arbitrary portable IDs distinct from every presentation node and edge', () => {
    const ids = ['__start', '__start:', '__output', 'a:b', 'a', 'b:c', 'c'];
    const blocks = presentationNodeIds(ids);
    expect(new Set([...ids, blocks.start, blocks.output]).size).toBe(ids.length + 2);
    const first = edgeKey({ from: 'a:b', to: 'c', kind: 'result' });
    const second = edgeKey({ from: 'a', to: 'b:c', kind: 'result' });
    expect(first).not.toBe(second);
    expect(isPresentationEdge(first)).toBe(false);
    expect(isPresentationEdge(presentationEdgeId('start', '__output'))).toBe(true);
  });

  it('tells which block and step a drawn wire belongs to, and nothing for a saved connection', () => {
    expect(presentationEdge(presentationEdgeId('output', 'a'))).toEqual({ kind: 'output', nodeId: 'a' });
    expect(presentationEdge(presentationEdgeId('start', 'a:b'))).toEqual({ kind: 'start', nodeId: 'a:b' });
    expect(presentationEdge(edgeKey({ from: 'a', to: 'b', kind: 'result' }))).toBeUndefined();
    expect(presentationEdge('plain text')).toBeUndefined();
    expect(presentationEdge(JSON.stringify(['presentation', 'middle', 'a']))).toBeUndefined();
  });
});
