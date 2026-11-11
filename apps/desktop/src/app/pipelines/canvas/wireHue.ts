/** Number of `--piui-wire-N` tokens in `styles/tokens.css`. */
export const WIRE_HUES = 6;

/** The CSS wire color of the step at `index` in the graph; presentation only. */
export function wireColor(index: number): string {
  return `var(--piui-wire-${(Math.max(0, index) % WIRE_HUES) + 1})`;
}

/** Hands out a wire color per step id; see {@link createWireAssigner}. */
export type WireAssigner = (ids: readonly string[]) => ReadonlyMap<string, string>;

/**
 * Keeps each step on the same wire hue for as long as it exists. A step that is
 * already known keeps its slot, so deleting another step never recolors the
 * rest; a new step takes the least used slot (the lowest one on a tie), so the
 * first six steps get the six hues in document order. A step that returns (undo)
 * gets its old slot back while that slot is still among the least used.
 */
export function createWireAssigner(): WireAssigner {
  const slots = new Map<string, number>();
  const remembered = new Map<string, number>();
  return (ids) => {
    const present = new Set(ids);
    for (const id of [...slots.keys()]) if (!present.has(id)) slots.delete(id);
    const usage = new Array<number>(WIRE_HUES).fill(0);
    for (const slot of slots.values()) usage[slot] += 1;
    for (const id of ids) {
      if (slots.has(id)) continue;
      const least = Math.min(...usage);
      const previous = remembered.get(id);
      const slot = previous !== undefined && usage[previous] === least ? previous : usage.indexOf(least);
      slots.set(id, slot);
      remembered.set(id, slot);
      usage[slot] += 1;
    }
    return new Map(ids.map((id) => [id, wireColor(slots.get(id) ?? 0)]));
  };
}

/**
 * A jagged "electric arc" polyline from `a` to `b`. `seed` changes the jitter so
 * redrawing with a new seed makes the arc crackle.
 */
export function sparkPath(a: { x: number; y: number }, b: { x: number; y: number }, seed: number, segments = 7, amplitude = 6): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  // Unit normal to the arc direction.
  const nx = -dy / length;
  const ny = dx / length;
  let state = (seed * 9301 + 49297) % 233280;
  const random = (): number => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
  const points = [`M${a.x.toFixed(1)},${a.y.toFixed(1)}`];
  for (let step = 1; step < segments; step += 1) {
    const t = step / segments;
    // Alternate sides so the arc zigzags; taper towards both ends.
    const side = step % 2 === 0 ? 1 : -1;
    const offset = side * amplitude * (0.45 + random() * 0.75) * Math.sin(Math.PI * t);
    points.push(`L${(a.x + dx * t + nx * offset).toFixed(1)},${(a.y + dy * t + ny * offset).toFixed(1)}`);
  }
  points.push(`L${b.x.toFixed(1)},${b.y.toFixed(1)}`);
  return points.join(' ');
}

/** An upstream step feeding a card through a result or route connection. */
export interface NodeInput {
  id: string;
  name: string;
  wire: string;
}
