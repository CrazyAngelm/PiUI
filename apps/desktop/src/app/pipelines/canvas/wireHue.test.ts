import { describe, expect, it } from 'vitest';
import { createWireAssigner, sparkPath, WIRE_HUES, wireColor } from './wireHue';

describe('wireColor', () => {
  it('gives neighboring steps different hues and cycles through the palette', () => {
    const colors = Array.from({ length: WIRE_HUES }, (_, index) => wireColor(index));
    expect(new Set(colors).size).toBe(WIRE_HUES);
    expect(wireColor(WIRE_HUES)).toBe(wireColor(0));
    expect(wireColor(0)).toBe('var(--piui-wire-1)');
  });

  it('falls back to the first hue for a negative index', () => {
    expect(wireColor(-3)).toBe('var(--piui-wire-1)');
  });
});

describe('createWireAssigner', () => {
  const ids = (count: number): string[] => Array.from({ length: count }, (_, index) => `n${index}`);

  it('gives the first steps the hues in document order, like wireColor', () => {
    const assign = createWireAssigner();
    const wires = assign(ids(WIRE_HUES));
    expect(ids(WIRE_HUES).map((id) => wires.get(id))).toEqual(ids(WIRE_HUES).map((_, index) => wireColor(index)));
  });

  it('does not recolor the other steps when a step is deleted', () => {
    const assign = createWireAssigner();
    const before = assign(ids(5));
    const after = assign(['n0', 'n1', 'n3', 'n4']);
    for (const id of ['n0', 'n1', 'n3', 'n4']) expect(after.get(id)).toBe(before.get(id));
  });

  it('keeps colors stable across repeated projections of the same graph', () => {
    const assign = createWireAssigner();
    const first = assign(ids(8));
    expect(assign(ids(8))).toEqual(first);
  });

  it('gives a new step the least used hue, avoiding the ones its neighbors have', () => {
    const assign = createWireAssigner();
    assign(ids(4));
    // n1 goes away: its hue is free again and the new step takes it.
    const wires = assign(['n0', 'n2', 'n3', 'new']);
    expect(wires.get('new')).toBe(wireColor(1));
    expect(new Set(['n0', 'n2', 'n3', 'new'].map((id) => wires.get(id))).size).toBe(4);
  });

  it('spreads steps evenly once there are more steps than hues', () => {
    const assign = createWireAssigner();
    const wires = assign(ids(WIRE_HUES * 2));
    const counts = new Map<string, number>();
    for (const wire of wires.values()) counts.set(wire, (counts.get(wire) ?? 0) + 1);
    expect([...counts.values()]).toEqual(new Array(WIRE_HUES).fill(2));
  });

  it('gives a restored step its old hue back when that hue is still free', () => {
    const assign = createWireAssigner();
    const before = assign(ids(3));
    assign(['n0', 'n2']);
    expect(assign(ids(3)).get('n1')).toBe(before.get('n1'));
  });
});

describe('sparkPath', () => {
  it('starts and ends exactly at the given points', () => {
    const path = sparkPath({ x: 0, y: 0 }, { x: 40, y: 10 }, 7);
    expect(path.startsWith('M0.0,0.0')).toBe(true);
    expect(path.endsWith('L40.0,10.0')).toBe(true);
    expect(path.split('L')).toHaveLength(7 + 1);
  });

  it('jitters with the seed but is deterministic for one seed', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 50, y: 0 };
    expect(sparkPath(a, b, 3)).toBe(sparkPath(a, b, 3));
    expect(sparkPath(a, b, 3)).not.toBe(sparkPath(a, b, 4));
  });

  it('does not produce NaN for a zero-length arc', () => {
    expect(sparkPath({ x: 5, y: 5 }, { x: 5, y: 5 }, 1)).not.toContain('NaN');
  });
});
