import { describe, expect, it } from 'vitest';
import {
  MAX_PANES,
  closePane,
  paneOf,
  panes,
  parseLayout,
  placePanes,
  resizeSplit,
  splitPane,
  withSession,
  type PaneLeaf,
  type PaneNode,
} from './paneLayout';

const leaf = (id: string, sessionId: string): PaneLeaf => ({ kind: 'pane', id, sessionId });
const split = (direction: 'row' | 'column', first: PaneNode, second: PaneNode, ratio = 0.5): PaneNode => ({ kind: 'split', direction, ratio, first, second });
const must = (node: PaneNode | undefined): PaneNode => {
  if (!node) throw new Error('Expected a layout.');
  return node;
};
const ids = (node: PaneNode | undefined): string[] => panes(node).map((item) => item.sessionId);

describe('panes and paneOf', () => {
  it('list leaves in reading order', () => {
    const tree = split('row', leaf('a', 'A'), split('column', leaf('b', 'B'), leaf('c', 'C')));
    expect(ids(tree)).toEqual(['A', 'B', 'C']);
    expect(paneOf(tree, 'C')?.id).toBe('c');
    expect(paneOf(tree, 'Z')).toBeUndefined();
  });
  it('treat no layout as no panes', () => {
    expect(panes(undefined)).toEqual([]);
    expect(paneOf(undefined, 'A')).toBeUndefined();
  });
});

describe('withSession', () => {
  it('replaces the chat of one pane and keeps the rest shared', () => {
    const second = leaf('b', 'B');
    const tree = split('row', leaf('a', 'A'), second);
    const next = withSession(tree, 'a', 'X');
    expect(ids(next)).toEqual(['X', 'B']);
    expect((next as { second: PaneNode }).second).toBe(second);
  });
  it('returns the same tree for an unknown pane', () => {
    const tree = split('row', leaf('a', 'A'), leaf('b', 'B'));
    expect(withSession(tree, 'nope', 'X')).toBe(tree);
  });
});

describe('splitPane', () => {
  const one = leaf('a', 'A');
  it('splits right and bottom with the new pane second, left and top with it first', () => {
    expect(splitPane(one, 'a', 'right', 'B', 'b')).toEqual(split('row', one, leaf('b', 'B')));
    expect(splitPane(one, 'a', 'left', 'B', 'b')).toEqual(split('row', leaf('b', 'B'), one));
    expect(splitPane(one, 'a', 'bottom', 'B', 'b')).toEqual(split('column', one, leaf('b', 'B')));
    expect(splitPane(one, 'a', 'top', 'B', 'b')).toEqual(split('column', leaf('b', 'B'), one));
  });
  it('splits a nested pane in place: one left, one right, a third bottom-left', () => {
    const two = must(splitPane(one, 'a', 'right', 'B', 'b'));
    const three = must(splitPane(two, 'a', 'bottom', 'C', 'c'));
    expect(three).toEqual(split('row', split('column', one, leaf('c', 'C')), leaf('b', 'B')));
    expect(ids(three)).toEqual(['A', 'C', 'B']);
  });
  it('refuses a fifth pane, an unknown pane and a chat that is already shown', () => {
    let tree: PaneNode = one;
    for (const [index, edge] of (['right', 'bottom', 'left'] as const).entries()) {
      tree = must(splitPane(tree, 'a', edge, `S${index}`, `p${index}`));
    }
    expect(panes(tree)).toHaveLength(MAX_PANES);
    expect(splitPane(tree, 'a', 'right', 'S9', 'p9')).toBeUndefined();
    expect(splitPane(one, 'nope', 'right', 'B', 'b')).toBeUndefined();
    expect(splitPane(one, 'a', 'right', 'A', 'b')).toBeUndefined();
    expect(splitPane(one, 'a', 'right', 'B', 'a')).toBeUndefined();
  });
});

describe('closePane', () => {
  it('collapses the parent so the sibling takes its place', () => {
    const tree = split('row', split('column', leaf('a', 'A'), leaf('c', 'C')), leaf('b', 'B'));
    expect(closePane(tree, 'a')).toEqual(split('row', leaf('c', 'C'), leaf('b', 'B')));
    expect(closePane(tree, 'b')).toEqual(split('column', leaf('a', 'A'), leaf('c', 'C')));
  });
  it('returns undefined for the only pane and the same tree for an unknown one', () => {
    expect(closePane(leaf('a', 'A'), 'a')).toBeUndefined();
    const tree = split('row', leaf('a', 'A'), leaf('b', 'B'));
    expect(closePane(tree, 'zzz')).toBe(tree);
  });
  it('collapses a two-pane layout to a single leaf', () => {
    expect(closePane(split('row', leaf('a', 'A'), leaf('b', 'B')), 'a')).toEqual(leaf('b', 'B'));
  });
});

describe('resizeSplit', () => {
  const tree = split('row', split('column', leaf('a', 'A'), leaf('c', 'C')), leaf('b', 'B'));
  it('sets the root ratio and a nested ratio', () => {
    expect(resizeSplit(tree, [], 0.3)).toMatchObject({ ratio: 0.3 });
    const nested = resizeSplit(tree, ['first'], 0.65) as { ratio: number; first: { ratio: number } };
    expect(nested.ratio).toBe(0.5);
    expect(nested.first.ratio).toBe(0.65);
  });
  it('clamps to the limits', () => {
    expect(resizeSplit(tree, [], 0.01)).toMatchObject({ ratio: 0.2 });
    expect(resizeSplit(tree, [], 0.99)).toMatchObject({ ratio: 0.8 });
  });
  it('ignores a path that is not a split and a non-finite ratio', () => {
    expect(resizeSplit(tree, ['second'], 0.3)).toBe(tree);
    expect(resizeSplit(tree, ['first', 'first'], 0.3)).toBe(tree);
    expect(resizeSplit(tree, [], Number.NaN)).toBe(tree);
    const single = leaf('a', 'A');
    expect(resizeSplit(single, [], 0.3)).toBe(single);
  });
});

describe('placePanes', () => {
  const keys = (node: Parameters<typeof placePanes>[0]): string[] => placePanes(node).map((place) => place.key);

  it('gives a single pane the whole area and no split', () => {
    expect(placePanes(leaf('p1', 'a'))).toEqual([{ kind: 'pane', key: 'pane:p1', leaf: leaf('p1', 'a'), left: 0, top: 0, width: 1, height: 1 }]);
    expect(placePanes(undefined)).toEqual([]);
  });

  it('places nested panes by the ratios, each split between its two halves at the box they share', () => {
    expect(placePanes(split('row', leaf('p1', 'a'), split('column', leaf('p2', 'b'), leaf('p3', 'c'), 0.25), 0.5))).toEqual([
      { kind: 'pane', key: 'pane:p1', leaf: leaf('p1', 'a'), left: 0, top: 0, width: 0.5, height: 1 },
      { kind: 'split', key: 'split:p1', path: [], direction: 'row', ratio: 0.5, left: 0, top: 0, width: 1, height: 1 },
      { kind: 'pane', key: 'pane:p2', leaf: leaf('p2', 'b'), left: 0.5, top: 0, width: 0.5, height: 0.25 },
      { kind: 'split', key: 'split:p2', path: ['second'], direction: 'column', ratio: 0.25, left: 0.5, top: 0, width: 0.5, height: 1 },
      { kind: 'pane', key: 'pane:p3', leaf: leaf('p3', 'c'), left: 0.5, top: 0.25, width: 0.5, height: 0.75 },
    ]);
  });

  it('keeps the keys that stay in the same order when a neighbour opens or closes', () => {
    const two = split('row', leaf('p1', 'a'), leaf('p2', 'b'));
    expect(keys(two)).toEqual(['pane:p1', 'split:p1', 'pane:p2']);
    const three = splitPane(two, 'p1', 'bottom', 'c', 'p3');
    expect(keys(three)).toEqual(['pane:p1', 'split:p1', 'pane:p3', 'split:p3', 'pane:p2']);
    expect(keys(closePane(three!, 'p2'))).toEqual(['pane:p1', 'split:p1', 'pane:p3']);
    expect(keys(closePane(three!, 'p1'))).toEqual(['pane:p3', 'split:p3', 'pane:p2']);
    // A pane that opens first comes first, with its own separator.
    expect(keys(splitPane(two, 'p1', 'left', 'c', 'p3'))).toEqual(['pane:p3', 'split:p3', 'pane:p1', 'split:p1', 'pane:p2']);
  });
});

describe('parseLayout', () => {
  const valid = split('row', leaf('a', 'A'), split('column', leaf('b', 'B'), leaf('c', 'C')), 0.4);
  it('round-trips a valid layout through JSON', () => {
    expect(parseLayout(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
    expect(parseLayout(leaf('a', 'A'))).toEqual(leaf('a', 'A'));
  });
  it('clamps a ratio that is out of range', () => {
    expect(parseLayout(split('row', leaf('a', 'A'), leaf('b', 'B'), 5))).toMatchObject({ ratio: 0.8 });
    expect(parseLayout(split('row', leaf('a', 'A'), leaf('b', 'B'), -1))).toMatchObject({ ratio: 0.2 });
  });
  it('drops fields it does not know', () => {
    expect(parseLayout({ ...leaf('a', 'A'), extra: 1 })).toEqual(leaf('a', 'A'));
  });
  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a string', 'row'],
    ['an array', []],
    ['an unknown kind', { kind: 'tab', id: 'a', sessionId: 'A' }],
    ['a pane without an id', { kind: 'pane', sessionId: 'A' }],
    ['a pane with an empty chat', { kind: 'pane', id: 'a', sessionId: '' }],
    ['a pane with a numeric chat', { kind: 'pane', id: 'a', sessionId: 4 }],
    ['an unknown direction', { ...split('row', leaf('a', 'A'), leaf('b', 'B')), direction: 'diagonal' }],
    ['a missing ratio', { kind: 'split', direction: 'row', first: leaf('a', 'A'), second: leaf('b', 'B') }],
    ['a NaN ratio', split('row', leaf('a', 'A'), leaf('b', 'B'), Number.NaN)],
    ['an infinite ratio', split('row', leaf('a', 'A'), leaf('b', 'B'), Number.POSITIVE_INFINITY)],
    ['a missing child', { kind: 'split', direction: 'row', ratio: 0.5, first: leaf('a', 'A') }],
    ['a repeated pane id', split('row', leaf('a', 'A'), leaf('a', 'B'))],
    ['a repeated chat', split('row', leaf('a', 'A'), leaf('b', 'A'))],
    [
      'five panes',
      split('row', split('row', leaf('a', 'A'), leaf('b', 'B')), split('row', leaf('c', 'C'), split('row', leaf('d', 'D'), leaf('e', 'E')))),
    ],
  ])('rejects %s', (_name, value) => {
    expect(parseLayout(value)).toBeUndefined();
  });
  it('accepts four panes', () => {
    const four = split('row', split('column', leaf('a', 'A'), leaf('b', 'B')), split('column', leaf('c', 'C'), leaf('d', 'D')));
    expect(parseLayout(four)).toEqual(four);
  });
});
